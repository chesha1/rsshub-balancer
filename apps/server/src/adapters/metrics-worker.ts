import {
  type MetricsBinding,
  type RouteRequestMetric,
  toMetricDataPoint,
} from '../metrics-schema'

// 使用当前请求的 binding 写入；来源由调用方指定，避免把 ingest 事件标成 Worker 自身流量。
export function recordMetric(
  metrics: MetricsBinding,
  event: RouteRequestMetric,
  plane: 'origin' | 'worker_failover',
): void {
  metrics.writeDataPoint(toMetricDataPoint(event, plane))
}
