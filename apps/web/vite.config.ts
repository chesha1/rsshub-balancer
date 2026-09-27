import { fileURLToPath } from 'node:url'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const outputDir = fileURLToPath(new URL('../../dist/apps/web', import.meta.url))
const localeResources = fileURLToPath(
  new URL('./src/locales/**', import.meta.url),
)

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
      // 首页开发统一通过线上内部接口读取真实数据。
      '/_internal': {
        target: 'https://rsshub-balancer.virworks.moe',
        changeOrigin: true,
      },
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
