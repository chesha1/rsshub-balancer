import { clearTimeout, setInterval, setTimeout } from 'node:timers'
import { metricsLogger } from '../log'
import {
  METRICS_MAX_BATCH_SIZE,
  METRICS_SCHEMA_VERSION,
  type RouteRequestMetric,
} from '../metrics-schema'

const NODE_METRICS_QUEUE_LIMIT = 2_000
const NODE_METRICS_FLUSH_THRESHOLD = 100
const NODE_METRICS_FLUSH_INTERVAL_MS = 15_000
const NODE_METRICS_UPLOAD_TIMEOUT_MS = 5_000

// 进程内有界队列只串行发送，每批发送前移除，任何失败均不重放以免重复计数。
const queue: RouteRequestMetric[] = []
let active: Promise<void> | undefined
let droppedEventCount = 0
let pendingDroppedEventCount = 0
let metricsIngestUrl = ''
let timer: ReturnType<typeof setInterval> | undefined

// 积压溢出和上传失败汇总计数，定期或批次结束才输出，避免逐事件刷日志。
function reportDrops(): void {
  if (!pendingDroppedEventCount) return
  metricsLogger.warn('node metrics events dropped', {
    event: 'metrics.upload',
    outcome: 'dropped',
    droppedEventCount: pendingDroppedEventCount,
    totalDroppedEventCount: droppedEventCount,
  })
  pendingDroppedEventCount = 0
}

// 所有丢弃原因共用计数；计数中不包含原始 payload 或上传错误对象。
function drop(count: number): void {
  droppedEventCount += count
  pendingDroppedEventCount += count
}

// 原生 fetch 使用中止信号限制上传时间；失败的批次不重试，避免远端重复计数。
async function send(events: RouteRequestMetric[]): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    NODE_METRICS_UPLOAD_TIMEOUT_MS,
  )
  timeout.unref()
  try {
    // 只向配置的 ingest 地址上传；取消响应体以释放连接且不保存服务端内容。
    const response = await fetch(metricsIngestUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ schemaVersion: METRICS_SCHEMA_VERSION, events }),
      signal: controller.signal,
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error('Metrics upload rejected')
  } catch {
    drop(events.length)
  } finally {
    clearTimeout(timeout)
  }
}

// 一个 drain 覆盖期间的所有批次，触发器只能复用它，保证进程内不会并行上传。
async function drain(): Promise<void> {
  try {
    while (queue.length > 0) {
      const events = queue.splice(0, METRICS_MAX_BATCH_SIZE)
      await send(events)
      reportDrops()
    }
  } finally {
    active = undefined
  }
}

// 数量和时间触发复用同一串行 drain；调用方无需在 RSS 路径等待它。
function flush(): Promise<void> {
  if (active) return active
  reportDrops()
  if (!queue.length) return Promise.resolve()
  active = drain()
  return active
}

// 由 metrics 模块初始化时按配置启用上传；重复启动复用已有定时器，导入模块本身不启动后台任务。
export function startMetricsUpload(url: string | undefined): void {
  if (!url || timer) return
  metricsIngestUrl = url
  timer = setInterval(() => {
    void flush()
  }, NODE_METRICS_FLUSH_INTERVAL_MS)
  timer.unref()
}

// 未启用时不积压事件；入队只做内存操作，达到阈值后由后台 Promise 提交。
export function recordMetric(event: RouteRequestMetric): void {
  if (!metricsIngestUrl) return
  if (queue.length === NODE_METRICS_QUEUE_LIMIT) {
    queue.shift()
    drop(1)
  }
  queue.push(event)
  if (queue.length >= NODE_METRICS_FLUSH_THRESHOLD) void flush()
}
