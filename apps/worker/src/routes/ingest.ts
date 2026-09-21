import { metricsLogger } from '@rsshub-balancer/server-core/log'
import type { RouteRequestMetric } from '@rsshub-balancer/server-core/metrics-schema'
import { Hono } from 'hono'
import { recordMetric } from '../metrics'

export const METRICS_INGEST_PATH = '/_internal/metrics/ingest'

// Cloudflare WAF 限制上传来源；接收端解析 JSON 后直接按固定字段映射写入。
export async function handleMetricsIngest(request: Request): Promise<Response> {
  if (request.url.includes('?')) return new Response(null, { status: 400 })
  let batch: { events: RouteRequestMetric[] }
  try {
    batch = (await request.json()) as { events: RouteRequestMetric[] }
  } catch {
    return new Response(null, { status: 400 })
  }

  try {
    for (const event of batch.events) {
      recordMetric(event)
    }
  } catch {
    // 平台写入没有事务；同步异常可能已部分写入，Node 不重试该批次。
    metricsLogger.warn('analytics ingest binding write failed', {
      event: 'metrics.ingest',
      outcome: 'failed',
    })
    return new Response(null, { status: 503 })
  }
  return new Response(null, { status: 204 })
}

export const ingestRoutes = new Hono<{ Bindings: CloudflareBindings }>()

// 路由层限制路径、方法和 binding，缓存头由公共中间件统一设置。
ingestRoutes.all(METRICS_INGEST_PATH, (c) => {
  if (!c.env.METRICS) return c.notFound()
  if (c.req.method !== 'POST') return c.body(null, 405, { Allow: 'POST' })
  return handleMetricsIngest(c.req.raw)
})
