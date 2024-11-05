import { spawn } from 'bun'
import { Hono } from 'hono'
import ms from 'ms'
import PQueue from 'p-queue'
import { getCachedThumbnail, getSignedUrlForVideo, uploadThumbnail } from './r2' // Import spawn from Bun

const app = new Hono()
const sharedHeaders = {
  'content-type': 'image/jpeg',
  'cache-control': 'public, max-age=31536000',
}

// Create a PQueue instance with a concurrency limit
const queue = new PQueue({ concurrency: 5 }) // Adjust concurrency as needed

app.get('/generate-thumbnail', async (c) => {
  const videoKey = c.req.query('key')

  if (!videoKey) {
    return c.text('Please add a ?key=videos/video.mp4 parameter', 400)
  }

  const timeStr = c.req.query('time') || '0s'
  const heightStr = c.req.query('height') || '720'
  const widthStr = c.req.query('width') || '1280'
  const fit = c.req.query('fit') || 'crop'

  const cacheKey = `${videoKey}-${timeStr}-${heightStr}-${widthStr}-${fit}`
  const cachedThumbnail = await getCachedThumbnail(cacheKey)
  if (cachedThumbnail) {
    console.log('Returning cached thumbnail:', cacheKey)
    return c.body(cachedThumbnail, 200, {
      ...sharedHeaders,
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

    // Add the task to the queue
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

        // Handle fit parameter
        let filter = ''

        if (fit === 'crop') {
          // Center crop
          filter = `crop=${width}:${height}:(in_w-${width})/2:(in_h-${height})/2`
        }
        else if (fit === 'clip' || fit === 'fill') {
          // Scale to fit within dimensions (maintaining aspect ratio), pad if necessary
          filter = `scale='iw*min(${width}/iw\\,${height}/ih)':'ih*min(${width}/iw\\,${height}/ih)',pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
        }
        else if (fit === 'scale') {
          // Stretch to fit the dimensions
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

        // Output format to stdout as JPEG
        ffmpegArgs.push('-f', 'image2pipe')
        ffmpegArgs.push('-vcodec', 'mjpeg')
        ffmpegArgs.push('-')

        console.log('Running ffmpeg with args:', ffmpegArgs)

        // Run ffmpeg process
        const ffmpegProcess = spawn({
          cmd: ['ffmpeg', ...ffmpegArgs],
          stdout: 'pipe',
          stderr: 'pipe',
        })

        // Collect stdout and stderr
        const stdoutChunks: Uint8Array[] = []
        const stderrChunks: Uint8Array[] = []

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

        // Combine stdout chunks into a single Buffer
        const imgBuffer = Buffer.concat(stdoutChunks)

        // Check if imgBuffer has data
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
      catch (error: any) {
        console.error(error)
        return {
          success: false,
          error: `Error processing video: ${error.message}`,
        }
      }
    })

    // Handle the result
    if (result?.success) {
      await uploadThumbnail(cacheKey, result.data)
      return c.body(result.data, 200, {
        ...sharedHeaders,
      })
    }
    else {
      return c.text(result?.error || 'Failed to generate thumbnail', 500)
    }
  }
  catch (error: any) {
    console.error(error)
    return c.text(`Error processing request: ${error.message}`, 500)
  }
})

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
}
