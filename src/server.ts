import { Hono } from 'hono'
import ms from 'ms'
import PQueue from 'p-queue'
import puppeteer, { Browser } from 'puppeteer' // Import the 'ms' package to parse time strings
import { getCachedThumbnail, getSignedUrlForVideo, uploadThumbnail } from './r2'

const app = new Hono()
const sharedHeaders = {
  'content-type': 'image/jpeg',
  'cache-control': 'public, max-age=31536000',
}
let browser: Browser // Global browser instance

// Function to launch the browser
async function launchBrowser() {
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // Use temporary disk storage instead of shared memory
    ],
  })

  browser.on('disconnected', () => {
    console.error('Browser disconnected. Restarting...')
    launchBrowser()
  })
}

// Initialize the browser and start the server
;(async () => {
  await launchBrowser()
})()

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
    console.log('returning cached thumbnail', cacheKey)
    return c.body(cachedThumbnail, 200, {
      ...sharedHeaders,
    })
  }

  console.log('generating thumbnail', cacheKey)

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
    const result = await queue.add<{ success: boolean, data?: any, error?: string }>(async () => {
      // Create a new page in the existing browser
      const page = await browser.newPage()

      try {
        // Set the viewport to match the desired dimensions
        await page.setViewport({ width, height })

        // Navigate to a blank page
        await page.goto('about:blank')
        // Define and execute the function in the page context
        const imageDataArray = await page.evaluate(
          async ({ videoSrc, timeSec, width, height, fit }) => {
            function generateVideoThumbnail(videoSrc, timeSec, width, height, fit) {
              return new Promise((resolve, reject) => {
                const video = document.createElement('video')
                video.crossOrigin = 'anonymous'
                video.preload = 'metadata'

                video.onloadedmetadata = () => {
                  // Ensure timeSec is within the video duration
                  if (timeSec > video.duration) {
                    timeSec = video.duration / 2 // Set to half the duration
                  }
                  video.currentTime = timeSec // Seek to specified time
                }

                video.onseeked = () => {
                  const canvas = document.createElement('canvas')
                  canvas.width = width // Set desired width
                  canvas.height = height // Set desired height
                  const ctx = canvas.getContext('2d')
                  if (ctx) {
                    const videoWidth = video.videoWidth
                    const videoHeight = video.videoHeight

                    if (fit === 'crop') {
                      // Calculate source rectangle to crop the video
                      const videoAspectRatio = videoWidth / videoHeight
                      const canvasAspectRatio = width / height

                      let sx, sy, sWidth, sHeight

                      if (canvasAspectRatio > videoAspectRatio) {
                        // Canvas is wider than video
                        sWidth = videoWidth
                        sHeight = videoWidth / canvasAspectRatio
                        sx = 0
                        sy = (videoHeight - sHeight) / 2
                      }
                      else {
                        // Canvas is taller than video
                        sWidth = videoHeight * canvasAspectRatio
                        sHeight = videoHeight
                        sx = (videoWidth - sWidth) / 2
                        sy = 0
                      }

                      ctx.drawImage(
                        video,
                        sx,
                        sy,
                        sWidth,
                        sHeight,
                        0,
                        0,
                        width,
                        height,
                      )
                    }
                    else if (fit === 'clip') {
                      // Fit the entire video frame into the canvas, maintaining aspect ratio
                      const videoAspectRatio = videoWidth / videoHeight
                      const canvasAspectRatio = width / height

                      let dx, dy, dWidth, dHeight

                      if (canvasAspectRatio > videoAspectRatio) {
                        // Canvas is wider than video
                        dHeight = height
                        dWidth = height * videoAspectRatio
                        dx = (width - dWidth) / 2
                        dy = 0
                      }
                      else {
                        // Canvas is taller than video
                        dWidth = width
                        dHeight = width / videoAspectRatio
                        dx = 0
                        dy = (height - dHeight) / 2
                      }

                      ctx.drawImage(
                        video,
                        0,
                        0,
                        videoWidth,
                        videoHeight,
                        dx,
                        dy,
                        dWidth,
                        dHeight,
                      )
                    }
                    else if (fit === 'scale') {
                      // Stretch the video to fill the canvas
                      ctx.drawImage(
                        video,
                        0,
                        0,
                        videoWidth,
                        videoHeight,
                        0,
                        0,
                        width,
                        height,
                      )
                    }
                    else if (fit === 'fill') {
                      // Fill the canvas with black background
                      ctx.fillStyle = 'black'
                      ctx.fillRect(0, 0, width, height)

                      // Fit the entire video frame into the canvas, maintaining aspect ratio
                      const videoAspectRatio = videoWidth / videoHeight
                      const canvasAspectRatio = width / height

                      let dx, dy, dWidth, dHeight

                      if (canvasAspectRatio > videoAspectRatio) {
                        // Canvas is wider than video
                        dHeight = height
                        dWidth = height * videoAspectRatio
                        dx = (width - dWidth) / 2
                        dy = 0
                      }
                      else {
                        // Canvas is taller than video
                        dWidth = width
                        dHeight = width / videoAspectRatio
                        dx = 0
                        dy = (height - dHeight) / 2
                      }

                      ctx.drawImage(
                        video,
                        0,
                        0,
                        videoWidth,
                        videoHeight,
                        dx,
                        dy,
                        dWidth,
                        dHeight,
                      )
                    }
                    else {
                      reject('Invalid fit parameter')
                      return
                    }

                    // Convert canvas to blob and then to array buffer
                    canvas.toBlob(
                      (blob) => {
                        if (blob) {
                          const reader = new FileReader()
                          reader.onloadend = () => {
                            const arrayBuffer = reader.result
                            const uint8Array = new Uint8Array(arrayBuffer)
                            resolve(Array.from(uint8Array))
                          }
                          reader.readAsArrayBuffer(blob)
                        }
                        else {
                          reject('Failed to create blob from canvas')
                        }
                      },
                      'image/jpeg',
                      0.8, // Quality parameter (optional)
                    )
                  }
                  else {
                    reject('Canvas context is not available')
                  }
                }

                video.onerror = () =>
                  reject(`Error loading video: ${video.error?.message}`)

                video.src = videoSrc
              })
            }

            return await generateVideoThumbnail(videoSrc, timeSec, width, height, fit)
          },
          {
            videoSrc: signedUrl,
            timeSec,
            width,
            height,
            fit,
          },
        )

        if ((imageDataArray as any) && (imageDataArray as any).length > 0) {
          const imgBuffer = Buffer.from(imageDataArray as any)

          return {
            success: true,
            data: imgBuffer,
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
      finally {
        await page.close()
      }

      return {
        success: false,
        error: 'Failed to generate thumbnail',
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
