import { metricsLogger } from './log'
import type { RouteRequestMetric } from './metrics-schema'

type MetricRecorder = (event: RouteRequestMetric) => void

let recordMetric: MetricRecorder | undefined

// 启动时固定本平台的记录函数，共享业务无需传递请求上下文或 binding。
export function configureMetrics(record: MetricRecorder): void {
  if (recordMetric && recordMetric !== record) {
    throw new Error('Metrics is already configured')
  }
  recordMetric = record
}

// 地域优先取 Worker metadata，Node 直接读取 CF-IPCountry；缺失或为空时沿用 unknown。
export function getRequestCountry(request: Request): string {
  const cf = (request as Request & { cf?: { country?: string } }).cf
  const country = cf?.country ?? request.headers.get('cf-ipcountry')
  return country?.trim() || 'unknown'
}

// 将国家与上游交给入口提供的记录函数，指标故障不影响主请求。
export function recordRouteRequestMetric(event: RouteRequestMetric): void {
  try {
    if (!recordMetric) throw new Error('Metrics is not configured')
    recordMetric(event)
  } catch {
    metricsLogger.warn('route request metric recording failed', {
      event: 'metrics.record',
      outcome: 'failed',
      droppedEventCount: 1,
    })
  }
}
