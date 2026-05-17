import { fileURLToPath } from 'node:url'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const outputDir = fileURLToPath(new URL('../../dist/apps/web', import.meta.url))
const localeResources = fileURLToPath(
  new URL('./src/locales/**', import.meta.url),
)

// 将大型但低频变化的图表依赖拆成独立 chunk，让业务代码改动时更容易复用浏览器缓存。
function splitVendorChunk(id: string) {
  const normalizedId = id.replaceAll('\\', '/')
  if (
    normalizedId.includes('/node_modules/echarts/') ||
    normalizedId.includes('/node_modules/zrender/') ||
    normalizedId.includes('/node_modules/vue-echarts/')
  ) {
    return 'chart-vendor'
  }

  if (normalizedId.includes('/node_modules/')) {
    return 'vendor'
  }
}

export default defineConfig({
  root: appRoot,
  plugins: [
    vue(),
    VueI18nPlugin({
      include: [localeResources],
    }),
  ],
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
    rollupOptions: {
      output: {
        manualChunks: splitVendorChunk,
      },
    },
  },
})
