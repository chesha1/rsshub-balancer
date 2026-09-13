import * as nodeMetrics from './adapters/metrics-node'
import * as workerMetrics from './adapters/metrics-worker'
import { metricsLogger } from './log'
import type { MetricsBinding } from './metrics-schema'
import type { RouteRequestOutcome } from './types'

type MetricsRuntime = 'node' | 'worker'

let runtime: MetricsRuntime | undefined

type RecordRouteRequestMetricOptions = {
  method: string
  status: number
  durationMs?: number
  outcome: RouteRequestOutcome
  upstream?: string
  country?: string
}

// 两个入口各调用一次完成初始化；Node 按环境配置启用后台上传，binding 不参与平台选择。
export function configureMetrics(value: MetricsRuntime): void {
  if (runtime && runtime !== value) {
    throw new Error('Metrics runtime is already initialized')
  }
  if (runtime === value) return
  if (value === 'node') {
    nodeMetrics.startMetricsUpload(process.env.METRICS_INGEST_URL)
  }
  runtime = value
}

// 未初始化时报告配置错误，避免误用另一端的指标写入路径。
function getRuntime(): MetricsRuntime {
  if (!runtime) throw new Error('Metrics runtime is not initialized')
  return runtime
}

// 地域优先取 Worker metadata，Node 直接读取 CF-IPCountry；缺失或为空时沿用 unknown。
export function getRequestCountry(request: Request): string {
  const cf = (request as Request & { cf?: { country?: string } }).cf
  const country = cf?.country ?? request.headers.get('cf-ipcountry')
  return country?.trim() || 'unknown'
}

// 统一补齐事件字段后按运行环境交给对应实现，指标故障不影响主请求。
export function recordRouteRequestMetric(
  metrics: MetricsBinding | undefined,
  options: RecordRouteRequestMetricOptions,
): void {
  const event = {
    method: options.method,
    status: options.status,
    durationMs: options.durationMs ?? 0,
    outcome: options.outcome,
    upstream: options.upstream ?? 'none',
    country: options.country ?? 'unknown',
  }
  try {
    if (getRuntime() === 'node') {
      nodeMetrics.recordMetric(event)
    } else if (metrics) {
      workerMetrics.recordMetric(metrics, event, 'worker_failover')
    }
  } catch {
    metricsLogger.warn('route request metric recording failed', {
      event: 'metrics.record',
      outcome: 'failed',
      droppedEventCount: 1,
    })
  }
}
