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
      // 语言包在构建时已预编译，运行时不打包消息编译器；
      // 文案都要写进 src/locales，不能在运行时传入待编译的字符串消息，例如 t() 的默认消息。
      dropMessageCompiler: true,
      // 不全局注册 <i18n-t>、v-t 等内置组件和指令，需要 <i18n-t> 时在组件中从 vue-i18n 局部引入 I18nT。
      fullInstall: false,
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
