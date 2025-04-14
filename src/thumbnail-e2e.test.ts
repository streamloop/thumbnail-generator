import { describe, expect, it } from 'vitest'
import { app } from './server-ffmpeg'

// --- E2E Test Suite ---
// Requirements:
// 1. ffmpeg installed and in PATH
// 2. R2 environment variables set (for getSignedUrlForVideo, uploadThumbnail, getCachedThumbnail)
// 3. The specified videoKey exists in the R2 bucket.

describe('/generate-thumbnail Simple E2E Tests', () => {
  // IMPORTANT: Ensure this video key exists in your R2 bucket
  const videoKey = 'obj_01jpd7dwwffmct783c6pn5qd8b.mp4'
  const time = '1s' // Use a fixed time

  // Helper function to make requests
  const makeRequest = async (params: Record<string, string>, acceptHeader = 'image/jpeg') => {
    const url = `/generate-thumbnail?key=${videoKey}&${new URLSearchParams(params)}&noCache=true`
    console.log(`Making request: ${url} (Accept: ${acceptHeader})`)
    try {
      const response = await app.request(url, {
        headers: { Accept: acceptHeader },
      })
      console.log(`Request finished with status: ${response.status}`)
      return response
    }
    catch (error) {
      console.error(`Request failed for ${url}:`, error)
      // Return a dummy response object to avoid crashing the test runner
      // The status check later will fail the test correctly.
      return new Response('Request failed in test helper', { status: 599 })
    }
  }

  const fitModes = ['contain', 'cover', 'crop', 'pad', 'scale', 'scale-down']
  const dimensions = [
    { width: '1920', height: '1080', desc: '1920x1080' },
    { width: '150', height: '150', desc: '150x150' },
  ]
  const formats = [
    { accept: 'image/jpeg', desc: 'JPEG' },
    { accept: 'image/avif,image/webp,*/*', desc: 'AVIF' },
  ]

  fitModes.forEach((fit) => {
    describe(`with fit='${fit}'`, () => {
      dimensions.forEach(({ width, height, desc: dimDesc }) => {
        formats.forEach(({ accept, desc: formatDesc }) => {
          const testTitle = `should complete successfully for ${dimDesc} as ${formatDesc}`

          it(testTitle, async () => {
            const params = { fit, width, height, time }
            const res = await makeRequest(params, accept)

            // Primary check: Did the request complete successfully?
            // Allow 304 for potential cache hits on reruns.
            expect([200, 304]).toContain(res.status)

            // Optional: Log body size on success
            if (res.ok && res.status !== 304) {
              try {
                const body = await res.arrayBuffer()
                console.log(` -> Success (${res.status}), received ${body.byteLength} bytes for ${testTitle}`)
              }
              catch (e) {
                console.error(' -> Error reading body on success', e)
              }
            }
            else if (res.status === 304) {
              console.log(` -> Success (304 Not Modified) for ${testTitle}`)
            }
            else {
              console.error(
                ` -> Failed (${res.status}) for ${testTitle}, Body: ${await res.text().catch(() => '')}`,
              )
            }
          }, 60000) // Explicit 60 second timeout per test
        })
      })
    })
  })
})
