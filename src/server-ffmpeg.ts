import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type Serve, spawn } from 'bun'
import { Hono } from 'hono'
import ms from 'ms'
import PQueue from 'p-queue'
import { getCachedThumbnail, getSignedUrlForVideo, uploadThumbnail } from './r2'

const app = new Hono()
// Default cache-control header remains the same
const CACHE_CONTROL = 'public, max-age=31536000'

// Create a PQueue instance with a concurrency limit
const queue = new PQueue({ concurrency: 5 }) // Adjust concurrency as needed

app.get('/generate-thumbnail', async (c) => {
  const videoKey = c.req.query('key')
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
  const fit = c.req.query('fit') || 'crop'
  const cacheKey = `${videoKey}-${timeStr}-${heightStr}-${widthStr}-${fit}-${supportsAvif ? 'avif' : 'jpeg'}`

  const cachedThumbnail = await getCachedThumbnail(cacheKey)
  if (cachedThumbnail) {
    console.log('Returning cached thumbnail:', cacheKey)
    return c.body(cachedThumbnail, 200, {
      'content-type': contentType,
      'cache-control': CACHE_CONTROL,
    })
  }

  console.log('Generating thumbnail:', cacheKey)

  // Parse time using 'ms' package
  const timeMs = ms(timeStr)
  if (typeof timeMs !== 'number' || isNaN(timeMs)) {
    return c.text('Invalid time parameter', 400)
  }
  const timeSec = timeMs / 1000

  // Parse height and width
  const height = Number.parseInt(heightStr, 10)
  const width = Number.parseInt(widthStr, 10)
  if (isNaN(height) || isNaN(width) || height <= 0 || width <= 0) {
    return c.text('Invalid height or width parameter', 400)
  }

  // Validate 'fit' parameter
  const validFits = ['crop', 'clip', 'scale', 'fill']
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
        if (fit === 'crop') {
          filter = `crop=${width}:${height}:(in_w-${width})/2:(in_h-${height})/2`
        }
        else if (fit === 'clip' || fit === 'fill') {
          filter = `scale='iw*min(${width}/iw\\,${height}/ih)':'ih*min(${width}/iw\\,${height}/ih)',pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
        }
        else if (fit === 'scale') {
          filter = `scale=${width}:${height}`
        }
        else {
          return {
            success: false,
            error: 'Invalid fit parameter',
          }
        }
        if (filter) {
          ffmpegArgs.push('-filter:v', filter)
        }

        if (supportsAvif) {
          // For AVIF: output to a temporary file (the avif muxer requires a seekable output)
          const tmpFilePath = path.join(os.tmpdir(), `thumbnail-${Date.now()}-${Math.random().toString(36).slice(2)}.avif`)
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
            stdout: 'inherit',
            stderr: 'pipe',
          })

          const stderrChunks = []
          for await (const chunk of ffmpegProcess.stderr) {
            stderrChunks.push(chunk)
          }
          const exitCode = await ffmpegProcess.exited

          if (exitCode !== 0) {
            const stderrOutput = Buffer.concat(stderrChunks).toString()
            console.error('ffmpeg error:', stderrOutput)
            return {
              success: false,
              error: `ffmpeg exited with code ${exitCode}: ${stderrOutput}`,
            }
          }

          // Read the generated file and then clean it up
          const imgBuffer = await fs.promises.readFile(tmpFilePath)
          await fs.promises.unlink(tmpFilePath)
          if (imgBuffer.length > 0) {
            return {
              success: true,
              data: imgBuffer,
            }
          }
          else {
            return {
              success: false,
              error: 'No data received from ffmpeg',
            }
          }
        }
        else {
          // For JPEG: output using mjpeg to stdout
          ffmpegArgs.push('-f', 'image2pipe')
          ffmpegArgs.push('-q:v', '3')
          ffmpegArgs.push('-vcodec', 'mjpeg')
          ffmpegArgs.push('-')

          console.log('Running ffmpeg with args:', ffmpegArgs)
          const ffmpegProcess = spawn({
            cmd: ['ffmpeg', ...ffmpegArgs],
            stdout: 'pipe',
            stderr: 'pipe',
          })

          const stdoutChunks = []
          const stderrChunks = []

          const stdoutPromise = (async () => {
            for await (const chunk of ffmpegProcess.stdout) {
              stdoutChunks.push(chunk)
            }
          })()

          const stderrPromise = (async () => {
            for await (const chunk of ffmpegProcess.stderr) {
              stderrChunks.push(chunk)
            }
          })()

          await Promise.all([stdoutPromise, stderrPromise])
          const exitCode = await ffmpegProcess.exited

          if (exitCode !== 0) {
            const stderrOutput = Buffer.concat(stderrChunks).toString()
            console.error('ffmpeg error:', stderrOutput)
            return {
              success: false,
              error: `ffmpeg exited with code ${exitCode}: ${stderrOutput}`,
            }
          }

          const imgBuffer = Buffer.concat(stdoutChunks)
          if (imgBuffer.length > 0) {
            return {
              success: true,
              data: imgBuffer,
            }
          }
          else {
            return {
              success: false,
              error: 'No data received from ffmpeg',
            }
          }
        }
      }
      catch (error) {
        console.error(error)
        return {
          success: false,
          error: `Error processing video: ${error.message}`,
        }
      }
    })

    if (result?.success) {
      await uploadThumbnail(cacheKey, result.data)
      return c.body(result.data, 200, {
        'content-type': outputMimeType,
        'cache-control': CACHE_CONTROL,
        'Vary': 'Accept',
      })
    }
    else {
      return c.text(result?.error || 'Failed to generate thumbnail', 500)
    }
  }
  catch (error) {
    console.error(error)
    return c.text(`Error processing request: ${error.message}`, 500)
  }
})

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
  // 30s
  idleTimeout: 30,
} satisfies Serve
