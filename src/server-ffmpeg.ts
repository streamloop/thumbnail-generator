import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { readableStreamToArrayBuffer, type Serve, spawn } from 'bun'
import { Hono } from 'hono'
import ms from 'ms'
import PQueue from 'p-queue'
import { getCachedThumbnail, getSignedUrlForVideo, uploadThumbnail } from './r2'

export const app = new Hono()
// Default cache-control header remains the same
const CACHE_CONTROL = 'public, max-age=31536000'

// Create a PQueue instance with a concurrency limit
const queue = new PQueue({ concurrency: 5 }) // Adjust concurrency as needed

app.get('/generate-thumbnail', async (c) => {
  const videoKey = c.req.query('key')
  const noCache = Boolean(c.req.query('noCache'))
  if (!videoKey) {
    return c.text('Please add a ?key=videos/video.mp4 parameter', 400)
  }

  const acceptHeader = c.req.header('accept') || ''
  const supportsAvif = acceptHeader.includes('image/avif')
  const contentType = supportsAvif
    ? 'image/avif'
    : 'image/jpeg'
  const outputMimeType = contentType

  const timeStr = c.req.query('time') || '0s'
  const heightStr = c.req.query('height') || '720'
  const widthStr = c.req.query('width') || '1280'
  const fit = c.req.query('fit') || 'cover'
  const cacheKey = `v3-${videoKey}-${timeStr}-${heightStr}-${widthStr}-${fit}-${supportsAvif ? 'avif' : 'jpeg'}`
  const etag = `"${cacheKey}"` // Generate ETag from cacheKey (wrap in quotes)

  // --- ETag Check --- (Do this before checking R2 cache)
  const ifNoneMatch = c.req.header('if-none-match')
  if (!noCache && ifNoneMatch && ifNoneMatch === etag) {
    // Client has the latest version, and we are not forcing a refresh
    return c.body(null, 304)
  }

  // --- R2 Cache Check --- (Only if not 304 and caching enabled)
  let cachedData: Buffer | null = null
  if (!noCache) {
    const cacheResult = await getCachedThumbnail(cacheKey)
    if (cacheResult) {
      if (cacheResult instanceof Buffer) {
        cachedData = cacheResult
      }
      else if (typeof (cacheResult as any).getReader === 'function') {
        console.log('Cached thumbnail is a stream, converting to Buffer...')
        try {
          const buffer = await readableStreamToArrayBuffer(cacheResult as ReadableStream)
          cachedData = Buffer.from(buffer)
        }
        catch (streamError) {
          console.error('Error reading cached stream:', streamError)
        }
      }
      else {
        console.warn('Unrecognized cache result type:', typeof cacheResult)
      }
    }
  }

  // Use cachedData Buffer
  if (cachedData) {
    console.log('Returning cached thumbnail from R2:', cacheKey)
    // Return 200 OK with data and ETag
    return c.body(cachedData.buffer as ArrayBuffer, 200, {
      'content-type': contentType,
      'cache-control': CACHE_CONTROL,
      'ETag': etag, // Add ETag header
    })
  }

  // --- Thumbnail Generation --- (Only if not 304 and cache miss)
  console.log('Generating thumbnail:', cacheKey)

  // Parse time using 'ms' package
  const timeMs = ms(timeStr)
  if (typeof timeMs !== 'number' || Number.isNaN(timeMs)) {
    return c.text('Invalid time parameter', 400)
  }
  const timeSec = timeMs / 1000

  // Parse height and width
  const height = Number.parseInt(heightStr, 10)
  const width = Number.parseInt(widthStr, 10)
  if (Number.isNaN(height) || Number.isNaN(width) || height <= 0 || width <= 0) {
    return c.text('Invalid height or width parameter', 400)
  }

  // Validate 'fit' parameter
  // See: https://developers.cloudflare.com/images/image-resizing/url-format/#fit
  const validFits = ['contain', 'cover', 'crop', 'scale-down', 'pad', 'scale']
  if (!validFits.includes(fit)) {
    return c.text(
      `Invalid fit parameter. Must be one of: ${validFits.join(', ')}`,
      400,
    )
  }

  try {
    const signedUrl = await getSignedUrlForVideo(videoKey)

    // Add the thumbnail generation task to the queue
    const result = await queue.add(async () => {
      let tmpFilePath: string | null = null
      try {
        // Build ffmpeg arguments
        const ffmpegArgs = []

        // Seek to the specified time
        ffmpegArgs.push('-ss', `${timeSec}`)
        // Input URL
        ffmpegArgs.push('-i', signedUrl)
        // Only process one frame
        ffmpegArgs.push('-frames:v', '1')

        // Build filter based on 'fit'
        let filter = ''
        if (fit === 'cover') {
          // Scale down/up to fill bounds, preserve aspect ratio, crop excess. (Like object-fit: cover)
          filter = `scale='max(iw*${height}/ih, ${width})':'max(ih*${width}/iw, ${height})',crop=${width}:${height}`
        }
        else if (fit === 'contain' || fit === 'pad') {
          // Scale down/up to fit within bounds, preserve aspect ratio, pad if needed. (Like object-fit: contain)
          // Pad uses -1 for centered coordinates and black background by default
          filter = `scale='min(${width},iw*${height}/ih)':'min(${height},ih*${width}/iw)',pad=${width}:${height}:-1:-1:color=black`
        }
        else if (fit === 'crop') {
          // Scale down (never up) to cover area, preserve aspect ratio, crop excess.
          // Output is at most target dimensions. No padding.
          filter = `scale='min(iw, max(iw*${height}/ih, ${width}))':'min(ih, max(ih*${width}/iw, ${height}))',crop='min(iw,${width})':'min(ih,${height})'`
        }
        else if (fit === 'scale-down') {
          // Scale down only if larger than bounds, preserve aspect ratio, pad if needed.
          // Pad uses -1 for centered coordinates and black background by default
          filter = `scale='min(iw,${width})':'min(ih,${height})':force_original_aspect_ratio=decrease,pad=${width}:${height}:-1:-1:color=black`
        }
        else if (fit === 'scale') {
          // Force scale to exact dimensions, ignore aspect ratio. (Like object-fit: fill)
          filter = `scale=${width}:${height}`
        }
        // No 'else' needed due to validFits check above

        if (filter) {
          ffmpegArgs.push('-filter:v', filter)
        }

        if (supportsAvif) {
          // For AVIF: output to a temporary file (the avif muxer requires a seekable output)
          tmpFilePath = path.join(os.tmpdir(), `thumbnail-${Date.now()}-${Math.random().toString(36).slice(2)}.avif`)
          ffmpegArgs.push('-c:v', 'libaom-av1')
          ffmpegArgs.push('-crf', '30')
          ffmpegArgs.push('-preset', 'fast')
          ffmpegArgs.push('-pix_fmt', 'yuv420p')
          ffmpegArgs.push('-f', 'avif')
          // Output to the temporary file
          ffmpegArgs.push(tmpFilePath)

          console.log('Running ffmpeg with args:', ffmpegArgs)
          const ffmpegProcess = spawn({
            cmd: ['ffmpeg', ...ffmpegArgs],
            stdout: 'ignore',
            stderr: 'pipe',
          })

          const stderrBuffer = await readableStreamToArrayBuffer(ffmpegProcess.stderr)
          const stderrOutput = Buffer.from(stderrBuffer).toString()
          const exitCode = await ffmpegProcess.exited

          if (stderrOutput.length > 0) {
            console.log('ffmpeg stderr (AVIF):', stderrOutput)
          }

          if (exitCode !== 0) {
            console.error('ffmpeg error (AVIF), Exit Code:', exitCode)
            return {
              success: false,
              error: `ffmpeg exited with code ${exitCode}: ${stderrOutput}`,
            }
          }

          const imgBuffer = await fs.promises.readFile(tmpFilePath)

          if (imgBuffer.length > 0) {
            return {
              success: true,
              data: Buffer.from(imgBuffer),
            }
          }
          else {
            return {
              success: false,
              error: 'Generated AVIF file is empty',
            }
          }
        }
        else {
          ffmpegArgs.push('-f', 'image2pipe')
          ffmpegArgs.push('-q:v', '3')
          ffmpegArgs.push('-vcodec', 'mjpeg')
          ffmpegArgs.push('-')

          console.log('Running ffmpeg (JPEG) with args:', ffmpegArgs)
          const ffmpegProcess = spawn({
            cmd: ['ffmpeg', ...ffmpegArgs],
            stdout: 'pipe',
            stderr: 'pipe',
          })

          const [stdoutBuffer, stderrBuffer] = await Promise.all([
            readableStreamToArrayBuffer(ffmpegProcess.stdout),
            readableStreamToArrayBuffer(ffmpegProcess.stderr),
          ])
          const exitCode = await ffmpegProcess.exited
          const stderrOutput = Buffer.from(stderrBuffer).toString()

          if (stderrOutput.length > 0) {
            console.log('ffmpeg stderr (JPEG):', stderrOutput)
          }

          if (exitCode !== 0) {
            console.error('ffmpeg error (JPEG), Exit Code:', exitCode)
            return {
              success: false,
              error: `ffmpeg exited with code ${exitCode}: ${stderrOutput}`,
            }
          }

          const imgBuffer = Buffer.from(stdoutBuffer)
          if (imgBuffer.length > 0) {
            return {
              success: true,
              data: imgBuffer,
            }
          }
          else {
            return {
              success: false,
              error: 'No JPEG data received from ffmpeg stdout',
            }
          }
        }
      }
      catch (error) {
        console.error('Error during thumbnail generation:', error)
        const errorMessage = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          error: `Error processing video: ${errorMessage}`,
        }
      }
      finally {
        if (tmpFilePath) {
          try {
            await fs.promises.unlink(tmpFilePath)
          }
          catch (unlinkError) {
            console.error(`Failed to delete temp file ${tmpFilePath}:`, unlinkError)
          }
        }
      }
    })

    if (result?.success && result.data && result.data.length > 0) {
      if (!noCache) {
        await uploadThumbnail(cacheKey, result.data)
      }
      return c.body(result.data.buffer as ArrayBuffer, 200, {
        'content-type': outputMimeType,
        'cache-control': CACHE_CONTROL,
        'ETag': etag, // Add ETag header
        'Vary': 'Accept',
      })
    }
    else {
      return c.text(result?.error || 'Failed to generate thumbnail', 500)
    }
  }
  catch (error) {
    console.error('Error handling /generate-thumbnail request:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return c.text(`Error processing request: ${errorMessage}`, 500)
  }
})

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
  // 30s
  idleTimeout: 30,
} satisfies Serve
