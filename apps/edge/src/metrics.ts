import { env } from 'cloudflare:workers'
import type { RouteRequestMetric } from '@rsshub-balancer/server-core/metrics-schema'

// 自身请求和 ingest 共用三列写入，在当前请求中读取 binding，不在启动时捕获它。
export function recordMetric(event: RouteRequestMetric): void {
  env.METRICS?.writeDataPoint({
    blobs: [event.country, event.upstream, event.path],
  })
}
