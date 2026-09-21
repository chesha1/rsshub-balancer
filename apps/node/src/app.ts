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
app.route('/', routes)
