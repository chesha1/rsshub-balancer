import { metricsLogger } from '@rsshub-balancer/server-core/log'
import type { RouteRequestMetric } from '@rsshub-balancer/server-core/metrics-schema'
import { recordMetric } from '../metrics'

export const METRICS_INGEST_PATH = '/_internal/metrics/ingest'

// 每个状态统一禁止浏览器和 Cloudflare CDN 存储，且不添加 CORS 许可。
function ingestResponse(status: number, allow?: string): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
  })
  if (allow) headers.set('Allow', allow)
  return new Response(null, { status, headers })
}

// Cloudflare WAF 限制上传来源；接收端解析 JSON 后直接按固定字段映射写入。
export async function handleMetricsIngest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== METRICS_INGEST_PATH) return ingestResponse(404)
  if (request.method !== 'POST') return ingestResponse(405, 'POST')
  if (url.search !== '' || request.url.includes('?')) return ingestResponse(400)
  let batch: { events: RouteRequestMetric[] }
  try {
    batch = (await request.json()) as { events: RouteRequestMetric[] }
  } catch {
    return ingestResponse(400)
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
    return ingestResponse(503)
  }
  return ingestResponse(204)
}
