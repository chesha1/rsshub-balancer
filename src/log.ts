import { AsyncLocalStorage } from 'node:async_hooks'
import {
  configureSync,
  getConsoleSink,
  getLogger,
  type LogRecord,
  withContext,
} from '@logtape/logtape'

// `X-` 前缀早已不是标准推荐做法；更标准化的分布式追踪通常会用 `traceparent`。
// 这里暂时还是继续使用 `X-Request-Id`，优先保持实现简单、可读和兼容现有习惯。
export const REQUEST_ID_HEADER = 'X-Request-Id'

type RequestLogContext = Record<string, unknown> & {
  requestId?: string
  requestMethod?: string
  requestPath?: string
  cfColo?: string
  cfCountry?: string
}

type RuntimeWarning = Error & {
  emitter?: unknown
  type?: string
  count?: number
}

// 仅把 Error 规范化为结构化日志友好的对象，保留 message/name/stack，
// 并递归展开 cause 与 AggregateError.errors；其它值交给调用方原样处理。
function normalizeError(
  error: Error,
  seen = new WeakSet<Error>(),
): Record<string, unknown> {
  if (seen.has(error)) {
    return {
      error: error.message,
      errorName: error.name,
      circular: true,
    }
  }
  seen.add(error)

  const normalized: Record<string, unknown> = {
    error: error.message,
    errorName: error.name,
  }
  if (typeof error.stack === 'string') normalized.stack = error.stack

  const cause = (error as Error & { cause?: unknown }).cause
  if (cause !== undefined) {
    normalized.cause =
      cause instanceof Error ? normalizeError(cause, seen) : cause
  }
  if (error instanceof AggregateError) {
    normalized.errors = error.errors.map((item) =>
      item instanceof Error ? normalizeError(item, seen) : item,
    )
  }

  for (const [key, value] of Object.entries(error)) {
    if (!(key in normalized)) {
      normalized[key] =
        value instanceof Error ? normalizeError(value, seen) : value
    }
  }

  return normalized
}

function formatMessagePart(part: unknown): string {
  if (typeof part === 'string') return part
  try {
    return JSON.stringify(part instanceof Error ? normalizeError(part) : part)
  } catch {
    return String(part)
  }
}

function formatMessage(parts: readonly unknown[]): string {
  return parts.map(formatMessagePart).join('')
}

// 耗时字段统一约定：
// 1. `durationMs` 只表示当前日志事件范围内的总墙钟耗时；
// 2. 分阶段耗时统一命名为 `{phase}DurationMs`；
// 3. 未进入的阶段不写 `0`，而是直接省略对应字段。
// Cloudflare 更适合直接消费结构化对象，因此这里把 LogTape record 展平成单个 JSON payload。
function formatRecord(record: LogRecord): Record<string, unknown> {
  return {
    timestamp: new Date(record.timestamp).toISOString(),
    level: record.level,
    category: record.category.join('.'),
    message: formatMessage(record.message),
    ...record.properties,
  }
}

const logContextStorage = new AsyncLocalStorage<Record<string, unknown>>()

// 整个 Worker 共用一套同步 console sink，避免每个模块各自重复初始化 logger。
configureSync({
  contextLocalStorage: logContextStorage,
  sinks: {
    console: getConsoleSink({
      formatter: (record) => [formatRecord(record)],
    }),
  },
  loggers: [
    {
      category: ['rsshub-balancer'],
      sinks: ['console'],
      lowestLevel: 'info',
    },
    {
      category: ['logtape'],
      sinks: ['console'],
      lowestLevel: 'warning',
    },
  ],
})

const rootLogger = getLogger(['rsshub-balancer'])

// 按模块拆分类别，方便后续在 Cloudflare 里按 category 过滤。
export const httpLogger = rootLogger.getChild('http')
export const upstreamLogger = rootLogger.getChild('upstream')
export const coalescerLogger = rootLogger.getChild('coalescer')
export const metricsLogger = rootLogger.getChild('metrics')
export const cronLogger = rootLogger.getChild('cron')
export const storeLogger = rootLogger.getChild('store')
export const runtimeLogger = rootLogger.getChild('runtime')

let runtimeWarningLoggerRegistered = false

// 提取 Cloudflare 请求元信息，给 Redis 等跨模块日志补充区域和路由上下文。
export function getRequestLogContext(request: Request): RequestLogContext {
  const url = new URL(request.url)
  const cf = request.cf as Record<string, unknown> | undefined
  const context: RequestLogContext = {
    requestMethod: request.method,
    requestPath: url.pathname + url.search,
  }

  if (typeof cf?.colo === 'string') context.cfColo = cf.colo
  if (typeof cf?.country === 'string') context.cfCountry = cf.country

  return context
}

// 从 Node warning 对象中提取 EventEmitter 诊断字段，避免日志里直接展开复杂对象。
function warningProps(warning: RuntimeWarning): Record<string, unknown> {
  const emitter = warning.emitter
  const emitterName =
    emitter && typeof emitter === 'object'
      ? emitter.constructor?.name
      : undefined

  return {
    warningName: warning.name,
    warningMessage: warning.message,
    warningStack: warning.stack,
    emitterName,
    warningType: warning.type,
    listenerCount: warning.count,
  }
}

// 注册一次 Node runtime warning 捕获，用来定位 MaxListenersExceededWarning 的来源。
function registerRuntimeWarningLogger(): void {
  if (runtimeWarningLoggerRegistered) return
  if (typeof process === 'undefined' || typeof process.on !== 'function') return

  runtimeWarningLoggerRegistered = true
  process.on('warning', (warning: RuntimeWarning) => {
    if (warning.name !== 'MaxListenersExceededWarning') return

    runtimeLogger.warn('runtime emitted max listeners warning', {
      event: 'runtime.warning',
      outcome: 'max_listeners_exceeded',
      ...warningProps(warning),
    })
  })
}

registerRuntimeWarningLogger()

// 为当前异步流程绑定 Request ID，后续任意模块 logger 都会自动带上它。
export function withRequestLogContext<T>(
  context: string | RequestLogContext,
  callback: () => T,
): T {
  const normalizedContext =
    typeof context === 'string' ? { requestId: context } : context
  return withContext(normalizedContext, callback)
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

// 给原生 Response 显式补上 X-Request-Id，保证直接返回 Response 的路径也能把请求 ID 回给客户端。
export function withResponseRequestId(
  response: Response,
  requestId = getCurrentRequestId(),
): Response {
  if (!requestId) return response

  const headers = new Headers(response.headers)
  headers.set(REQUEST_ID_HEADER, requestId)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function getRequestId(request: Request): string | null {
  return request.headers.get(REQUEST_ID_HEADER)
}

// Error 提取核心字段，其它值尽量原样保留给结构化日志系统处理。
export function errorProps(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return normalizeError(error)
  }
  return {
    error:
      typeof error === 'bigint' ||
      typeof error === 'symbol' ||
      typeof error === 'function'
        ? String(error)
        : error,
  }
}
