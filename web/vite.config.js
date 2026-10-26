import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Built files go under /ui/ so they never clash with the server's own /assets (landing page images).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { assetsDir: 'ui' },
  server: { proxy: { '/api': 'http://localhost:3000', '/app/api': 'http://localhost:3000' } },
})
