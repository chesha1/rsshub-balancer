import { errorProps, metricsLogger } from './log'

export type MetricsMetric =
  | 'route_request'
  | 'coalesce_role'
  | 'direct_upstream'
  | 'benefited'

export type MetricsLayer = 'edge' | 'isolate' | 'do'

export type MetricsRole = 'leader' | 'follower' | 'none'

export type MetricsReason =
  | 'non_get'
  | 'do_leader'
  | 'do_rpc_failed'
  | 'do_sampled_out'
  | 'isolate_follower'
  | 'do_follower'
  | 'none'

type RecordMetricOptions = {
  metric: MetricsMetric
  layer: MetricsLayer
  role?: MetricsRole
  method?: string
  reason?: MetricsReason
  status?: number
  durationMs?: number
  upstream?: string
}

// 将合并收益事件写入 Analytics Engine；写入失败只记录日志，不能影响主请求。
export function recordMetric(
  metrics: AnalyticsEngineDataset,
  options: RecordMetricOptions,
) {
  const role = options.role ?? 'none'
  const method = options.method ?? 'none'
  const reason = options.reason ?? 'none'
  const status = options.status === undefined ? 'none' : String(options.status)
  const durationMs = options.durationMs ?? 0
  const upstream = options.upstream ?? 'none'

  try {
    metrics.writeDataPoint({
      indexes: ['global'],
      blobs: [
        options.metric,
        options.layer,
        role,
        method,
        reason,
        status,
        upstream,
      ],
      doubles: [1, durationMs],
    })
  } catch (e) {
    metricsLogger.warn('analytics engine metric write failed', {
      event: 'metrics.write',
      outcome: 'failed',
      metric: options.metric,
      layer: options.layer,
      role,
      method,
      reason,
      status,
      upstream,
      ...errorProps(e),
    })
  }
}
