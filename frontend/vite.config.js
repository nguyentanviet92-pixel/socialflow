import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true
  },
  preview: {
    port: 3006,
    host: '0.0.0.0',
    allowedHosts: true
  },
  build: {
    sourcemap: false,
  },
})

