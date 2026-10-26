import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  appType: 'mpa',
  plugins: [tailwindcss()],
  optimizeDeps: {
    include: ['leaflet', '@js-temporal/polyfill'],
  },
  server: {
    port: 5173,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  },
  preview: {
    port: 4173,
  },
})
