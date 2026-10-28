import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Built files go under /ui/ so they never clash with the server's own /assets (landing page images).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // fonts.css is also built on its own under a fixed name, for the server's pages (see src/fonts.css).
  build: {
    assetsDir: 'ui',
    rollupOptions: {
      input: { index: 'index.html', fonts: 'src/fonts.css' },
      output: { assetFileNames: (a) => (a.names?.includes('fonts.css') ? 'ui/fonts.css' : 'ui/[name]-[hash][extname]') },
    },
  },
  server: { proxy: { '/api': 'http://localhost:3000', '/app/api': 'http://localhost:3000' } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{js,jsx}'] },
})
