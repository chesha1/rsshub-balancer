import { errorProps, metricsLogger } from './log'
import type { RouteRequestOutcome } from './types'

type RecordRouteRequestMetricOptions = {
  method?: string
  status?: number
  durationMs?: number
  outcome: RouteRequestOutcome
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

// 记录入口请求最终由哪种方式服务；写入失败只记录日志，不能影响主请求。
export function recordRouteRequestMetric(
  metrics: AnalyticsEngineDataset,
  options: RecordRouteRequestMetricOptions,
) {
  const method = options.method ?? 'none'
  const status = options.status === undefined ? 'none' : String(options.status)
  const durationMs = options.durationMs ?? 0
  const upstream = options.upstream ?? 'none'
  const country = options.country ?? 'none'
  const edgeColo = options.edgeColo ?? 'none'

  try {
    metrics.writeDataPoint({
      indexes: ['global'],
      blobs: [
        'route_request',
        'edge',
        'none',
        method,
        options.outcome,
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
      metric: 'route_request',
      layer: 'edge',
      role: 'none',
      method,
      routeRequestOutcome: options.outcome,
      status,
      upstream,
      country,
      edgeColo,
      ...errorProps(e),
    })
  }
}
