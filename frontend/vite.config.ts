import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // No heavy Node-only SDKs anymore; AWS SDK v3 works natively in browser
  },
  server: {
    port: 5173,
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
  define: {
    global: 'globalThis',
  },
})
