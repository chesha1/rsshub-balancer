import { registerCommonMiddleware, routes } from '@rsshub-balancer/server-core'
import * as metrics from '@rsshub-balancer/server-core/metrics'
import * as redis from '@rsshub-balancer/server-core/redis'
import { Hono } from 'hono'
import * as workerMetrics from './metrics'
import { runRedisCommand } from './redis'
import { ingestRoutes } from './routes/ingest'

// 只配置函数引用，binding 在指标写入时由 Worker 模块读取。
redis.configureRedis('worker', runRedisCommand)
metrics.configureMetrics(workerMetrics.recordMetric)

export const app = new Hono<{ Bindings: EdgeBindings }>()
registerCommonMiddleware(app)
// 接管后从公网健康响应确认 edge 已承接请求，不依赖内容相同的成功正文。
app.use('/healthz', async (c, next) => {
  await next()
  c.header('X-RSSHub-App', 'edge')
})

// ingest 继承公共中间件，并先于共享路由的保留路径 404 和 RSS catch-all 注册。
app.route('/', ingestRoutes)
app.route('/', routes)
