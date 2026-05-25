import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    open: true
  },
  preview: {
    port: 3006,
    host: '0.0.0.0',
    allowedHosts: true // Allow sslip.io or other host headers in Vite 6
  },
  build: {
    // Sourcemap để debug được production minified errors (vd React error #310).
    // Cost: dist tăng ~30%, deploy chậm hơn vài giây. Worth it.
    sourcemap: true,
  },
})
