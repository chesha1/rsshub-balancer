import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const outputDir = fileURLToPath(new URL('../../dist/apps/web', import.meta.url))

export default defineConfig({
  root: appRoot,
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/_internal': 'http://127.0.0.1:8787',
      '/api': 'http://127.0.0.1:8787',
      '/healthz': 'http://127.0.0.1:8787',
      '/robots.txt': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: outputDir,
    emptyOutDir: true,
    assetsDir: '_assets',
  },
})
