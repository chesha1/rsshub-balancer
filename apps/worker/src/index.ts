import { scheduled } from '@rsshub-balancer/server-core'
import { app } from './app'

export default {
  // 请求交给本应用路由，平台 binding 在处理当前请求时使用。
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx)
  },
  // Cron 直接调用原来的刷新函数，写入 Worker 自己的 Redis key。
  async scheduled() {
    await scheduled()
  },
} satisfies ExportedHandler<CloudflareBindings>
