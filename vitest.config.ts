import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Vitest configuration options
    globals: true, // Use globals like describe, it, expect without importing
    environment: 'node', // Set the testing environment
    clearMocks: true, // Automatically clear mock calls between tests
    testTimeout: 60000, // Increase timeout to 60 seconds for AVIF encoding
    // If needed, configure coverage options:
    // coverage: {
    //   provider: 'v8',
    //   reporter: ['text', 'json', 'html'],
    //   reportsDirectory: './coverage',
    // },
  },
  resolve: {
    alias: {
      // Define the same path aliases as in tsconfig.json
      '@': path.resolve(__dirname, './src'),
    },
  },
})
