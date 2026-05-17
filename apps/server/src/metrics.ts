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
  country?: string
  edgeColo?: string
}

// 从 Cloudflare request metadata 中提取国家/地区代码，缺失或异常时统一归为 unknown。
export function getRequestCountry(request: Request): string {
  const cf = request.cf as Record<string, unknown> | undefined
  const country = cf?.country
  if (typeof country !== 'string') return 'unknown'

  const normalizedCountry = country.trim()
  return normalizedCountry.length > 0 ? normalizedCountry : 'unknown'
}

// 从 Cloudflare request metadata 中提取入口机房代码，缺失或异常时统一归为 unknown。
export function getRequestColo(request: Request): string {
  const cf = request.cf as Record<string, unknown> | undefined
  const colo = cf?.colo
  if (typeof colo !== 'string') return 'unknown'

  const normalizedColo = colo.trim()
  return normalizedColo.length > 0 ? normalizedColo : 'unknown'
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
  const country = options.country ?? 'none'
  const edgeColo = options.edgeColo ?? 'none'

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
        country,
        edgeColo,
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
      country,
      edgeColo,
      ...errorProps(e),
    })
  }
}
