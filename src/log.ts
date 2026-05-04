import {
  configureSync,
  getConsoleSink,
  getLogger,
  type Logger,
  type LogRecord,
} from '@logtape/logtape'

// `X-` 前缀早已不是标准推荐做法；更标准化的分布式追踪通常会用 `traceparent`。
// 这里暂时还是继续使用 `X-Request-Id`，优先保持实现简单、可读和兼容现有习惯。
export const REQUEST_ID_HEADER = 'X-Request-Id'

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

// 整个 Worker 共用一套同步 console sink，避免每个模块各自重复初始化 logger。
configureSync({
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

export type RequestLogger = Logger

// 把当前请求的固定字段预先绑定到 logger 上，减少每次打日志时重复拼上下文。
export function bindRequestLogger(
  logger: Logger,
  requestId: string,
  request: Request,
): Logger {
  const url = new URL(request.url)
  return logger.with({
    requestId,
    method: request.method,
    path: url.pathname,
  })
}

// Hono requestId middleware 只会把值写到 context/response，内部转发时需要手动补到请求头上。
export function withRequestId(request: Request, requestId: string): Request {
  const headers = new Headers(request.headers)
  headers.set(REQUEST_ID_HEADER, requestId)
  return new Request(request, { headers })
}

// 给原生 Response 显式补上 X-Request-Id，保证直接返回 Response 的路径也能把请求 ID 回给客户端。
export function withResponseRequestId(
  response: Response,
  requestId: string,
): Response {
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
