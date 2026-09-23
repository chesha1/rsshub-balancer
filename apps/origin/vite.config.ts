import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const outputDir = fileURLToPath(
  new URL('../../dist/apps/origin', import.meta.url),
)

// Node 配置在启动时读取，构建只生成后端产物，不加载本地环境文件或静态资源。
export default defineConfig({
  root: appRoot,
  envDir: false,
  publicDir: false,
  ssr: {
    target: 'node',
    noExternal: true,
  },
  build: {
    ssr: 'src/index.ts',
    outDir: outputDir,
    emptyOutDir: true,
    target: 'node26',
    minify: false,
    sourcemap: true,
    rolldownOptions: {
      output: {
        format: 'es',
        entryFileNames: 'index.js',
        // 合并依赖并补齐 CommonJS require，使运行容器只需携带 Node 和构建产物。
        codeSplitting: false,
        polyfillRequire: true,
      },
    },
  },
})
