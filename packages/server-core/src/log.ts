import { AsyncLocalStorage } from 'node:async_hooks'
import {
  configureSync,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  type LogRecord,
  withContext,
} from '@logtape/logtape'

// `X-` 前缀早已不是标准推荐做法；更标准化的分布式追踪通常会用 `traceparent`。
// 这里暂时还是继续使用 `X-Request-Id`，优先保持实现简单、可读和兼容现有习惯。
export const REQUEST_ID_HEADER = 'X-Request-Id'

type RequestLogContext = {
  requestId: string
  requestMethod: string
  requestPath: string
}

const jsonLinesFormatter = getJsonLinesFormatter()

// 异常值无法转为 JSON 时仍用 LogTape 输出一条简短诊断，避免丢失整条日志。
function formatLogRecord(record: LogRecord): string {
  try {
    return jsonLinesFormatter(record)
  } catch {
    return jsonLinesFormatter({
      category: record.category,
      level: record.level,
      message: ['log record serialization failed'],
      rawMessage: 'log record serialization failed',
      timestamp: record.timestamp,
      properties: { serializationFailed: true },
    })
  }
}

const logContextStorage = new AsyncLocalStorage<Record<string, unknown>>()

// 两端共用 JSON Lines console sink，只在实际输出警告或错误时序列化。
configureSync({
  contextLocalStorage: logContextStorage,
  sinks: {
    console: getConsoleSink({
      formatter: formatLogRecord,
    }),
  },
  loggers: [
    {
      category: ['rsshub-balancer'],
      sinks: ['console'],
      lowestLevel: 'warning',
    },
    {
      category: ['logtape'],
      sinks: ['console'],
      lowestLevel: 'warning',
    },
  ],
})

const rootLogger = getLogger(['rsshub-balancer'])

// 日志属性中的 durationMs 表示事件总墙钟耗时，分阶段耗时用 {phase}DurationMs，未进入的阶段省略。
// 按模块拆分类别，JSON 日志用 logger 字段区分。
export const httpLogger = rootLogger.getChild('http')
export const upstreamLogger = rootLogger.getChild('upstream')
export const metricsLogger = rootLogger.getChild('metrics')
export const cronLogger = rootLogger.getChild('cron')
export const redisLogger = rootLogger.getChild('redis')
export const runtimeLogger = rootLogger.getChild('runtime')

// 为当前异步流程绑定 Request ID，后续任意模块 logger 都会自动带上它。
export function withRequestLogContext<T>(
  context: RequestLogContext,
  callback: () => T,
): T {
  return withContext(context, callback)
}

// 读取当前异步请求上下文里的 Request ID，供 header 透传等非日志场景复用。
export function getCurrentRequestId(): string | undefined {
  const requestId = logContextStorage.getStore()?.requestId
  return typeof requestId === 'string' ? requestId : undefined
}

// Hono requestId middleware 只会把值写到 context/response，内部转发时需要手动补到请求头上。
export function withRequestId(
  request: Request,
  requestId = getCurrentRequestId(),
): Request {
  if (!requestId) return request
  if (request.headers.get(REQUEST_ID_HEADER) === requestId) return request

  const headers = new Headers(request.headers)
  headers.set(REQUEST_ID_HEADER, requestId)
  return new Request(request, { headers })
}

// 从请求头中读取链路关联 ID，供需要显式传递的调用方使用。
export function getRequestId(request: Request): string | null {
  return request.headers.get(REQUEST_ID_HEADER)
}
