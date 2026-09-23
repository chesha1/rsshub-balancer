import { registerCommonMiddleware, routes } from '@rsshub-balancer/server-core'
import * as metrics from '@rsshub-balancer/server-core/metrics'
import * as redis from '@rsshub-balancer/server-core/redis'
import { Hono } from 'hono'
import * as nodeMetrics from './metrics'
import { runRedisCommand } from './redis'

// 应用加载时固定平台实现；连接、监听和上传定时器仍按原有生命周期启动。
redis.configureRedis('node', runRedisCommand)
metrics.configureMetrics(nodeMetrics.recordMetric)

export const app = new Hono()
registerCommonMiddleware(app)
// 探活通过应用标识确认固定入口仍到达 origin，健康判断继续使用共享接口。
app.use('/healthz', async (c, next) => {
  await next()
  c.header('X-RSSHub-App', 'origin')
})
app.route('/', routes)
