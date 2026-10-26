import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

function githubPagesBase(): string {
  if (process.env.GITHUB_ACTIONS !== 'true') return '/'
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
  if (!repo || repo.endsWith('.github.io')) return '/'
  return `/${repo}/`
}

export default defineConfig({
  base: githubPagesBase(),
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
