import type { RouteRequestOutcome } from './types'

export type RouteRequestMetric = {
  method: string
  status: number
  durationMs: number
  outcome: RouteRequestOutcome
  upstream: string
  country: string
}

export type MetricDataPoint = {
  indexes: string[]
  blobs: string[]
  doubles: number[]
}

// 共享层只依赖实际用到的写入能力，不引用 Workers 全局类型。
export type MetricsBinding = {
  writeDataPoint(point: MetricDataPoint): void
}

export const METRICS_SCHEMA_VERSION = 2
export const METRICS_MAX_BATCH_SIZE = 200

// 固定 v2 的列位置，两种入口使用同一映射，历史列的位置保持不变。
export function toMetricDataPoint(
  event: RouteRequestMetric,
  plane: 'origin' | 'worker_failover',
): MetricDataPoint {
  return {
    indexes: ['global'],
    blobs: [
      'route_request',
      plane === 'origin' ? 'origin' : 'edge',
      'none',
      event.method,
      event.outcome,
      String(event.status),
      event.upstream,
      event.country,
      '',
      plane,
      String(METRICS_SCHEMA_VERSION),
    ],
    doubles: [1, event.durationMs],
  }
}
