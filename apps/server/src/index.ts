import app from './app'
import * as metrics from './metrics'
import * as redis from './redis'
import { scheduled } from './scheduled'

redis.configureRedis('worker')
metrics.configureMetrics('worker')

export default {
  // 在当前请求中传入 Worker bindings，共享业务直接使用模块函数。
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx)
  },
  // Cron 直接调用原来的刷新函数，写入 Worker 自己的 Redis key。
  async scheduled() {
    await scheduled()
  },
} satisfies ExportedHandler<CloudflareBindings>
