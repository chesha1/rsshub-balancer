import { fileURLToPath, URL } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig, type EnvironmentModuleNode } from 'vite'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const outputDir = fileURLToPath(
  new URL('../../dist/apps/worker', import.meta.url),
)

// 保留 Redis 的动态导入边界；官方插件处理 Node 兼容并生成不再合包的部署配置。
export default defineConfig({
  root: appRoot,
  envDir: false,
  // 首页仍由独立的 Web 项目构建，再作为静态资源复制进 Worker 发布产物。
  publicDir: fileURLToPath(new URL('../../dist/apps/web', import.meta.url)),
  plugins: [
    // 默认允许远程绑定；具体资源仍通过 Wrangler 配置中的 remote: true 选择。
    cloudflare({ remoteBindings: true, viteEnvironment: { name: 'worker' } }),
    {
      name: 'reload-worker-modules',
      apply: 'serve',
      // 共享模块只配置一次；开发时整体重载，避免局部替换执行器后仍持有旧配置和缓存。
      hotUpdate({ modules, timestamp }) {
        if (this.environment.name !== 'worker' || modules.length === 0) return
        const invalidated = new Set<EnvironmentModuleNode>()
        // 自行触发重载前先清理变更模块的转换缓存，确保重新加载时读取最新源码。
        for (const module of modules) {
          this.environment.moduleGraph.invalidateModule(
            module,
            invalidated,
            timestamp,
            true,
          )
        }
        this.environment.hot.send({ type: 'full-reload' })
        return []
      },
    },
  ],
  // 固定首页开发代理的目标地址，端口占用时直接报错。
  server: {
    host: '127.0.0.1',
    port: 8787,
    strictPort: true,
  },
  build: {
    emptyOutDir: true,
    minify: true,
    sourcemap: true,
  },
  environments: {
    // 静态资源与脚本目录并列，避免部署时把首页 JS 也收集为 Worker 模块。
    worker: { build: { outDir: `${outputDir}/server` } },
    client: { build: { outDir: `${outputDir}/public` } },
  },
})
