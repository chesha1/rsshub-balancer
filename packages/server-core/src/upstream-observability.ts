import { getCurrentRequestId, upstreamLogger } from './log'

export type UpstreamDiagnosticTrace = {
  logged: boolean
  onLogged?: () => void
}

export type UpstreamIssue = {
  stage: 'health' | 'cache' | 'feed'
  url: string
  reason: string
  action: string
  response?: Response
  body?: string
  error?: unknown
  signal?: AbortSignal
  durationMs?: number
  ttlSeconds?: number
  method?: string
  requestId?: string
  trace?: UpstreamDiagnosticTrace
  sampleBody?: boolean
}

type DiagnosticError = {
  errorName: string
  errorCode?: string
  failureKind: 'timeout' | 'aborted' | 'network' | 'error'
}

type Prefix = {
  prefixState:
    | 'sampled'
    | 'empty'
    | 'disabled'
    | 'not_applicable'
    | 'unavailable'
  prefixBytes: number
  prefixLimitBytes: number
  prefixTruncated: boolean
  prefixError?: string
  text?: string
}

const PREFIX_LIMIT = 8 * 1024
const PREFIX_TIMEOUT_MS = 200
const LOG_INTERVAL_MS = 60_000
const MAX_RATE_KEYS = 256
const rateSlots = new Map<
  string,
  { lastLoggedAt: number; suppressed: number }
>()
let runtime: 'origin' | 'edge' | undefined
let diagnosticSequence = 0

const ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'TimeoutError',
  'AbortError',
  'AggregateError',
  'FetchError',
  'SystemError',
  'HTTPError',
  'DOMException',
])
const ERROR_CODES = new Set([
  'ABORT_ERR',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNABORTED',
  'ERR_NETWORK',
  'ERR_INVALID_URL',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT',
  'UND_ERR_ABORTED',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
])

// 平台入口只登记运行位置，不引入存储、后台任务或跨运行时依赖。
export function configureUpstreamDiagnostics(value: 'origin' | 'edge'): void {
  runtime = value
}

// 最终请求摘要复用同一运行位置，避免异常记录与收尾记录显示不同平台。
export function getUpstreamDiagnosticRuntime(): 'origin' | 'edge' | 'unknown' {
  return runtime ?? 'unknown'
}

// 对外日志只保留 HTTP(S) 来源和路径，任何用户名、密码、查询或片段都被丢弃。
export function safeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'invalid'
    return url.origin + url.pathname
  } catch {
    return 'invalid'
  }
}

// 仅读取错误名称和标准代码，不触碰可能包含凭据、URL 或堆栈的 message/stack。
export function safeDiagnosticError(
  error: unknown,
  signal?: AbortSignal,
): DiagnosticError {
  try {
    const source =
      error && typeof error === 'object'
        ? (error as {
            name?: unknown
            code?: unknown
            cause?: { code?: unknown }
          })
        : undefined
    const name =
      typeof source?.name === 'string' && ERROR_NAMES.has(source.name)
        ? source.name
        : 'Error'
    const candidateCode =
      typeof source?.code === 'string' ? source.code : source?.cause?.code
    const code =
      typeof candidateCode === 'string' && ERROR_CODES.has(candidateCode)
        ? candidateCode
        : undefined
    const reasonName = signal?.aborted ? signal.reason?.name : undefined
    const timeout =
      name === 'TimeoutError' ||
      reasonName === 'TimeoutError' ||
      code === 'ETIMEDOUT' ||
      Boolean(code?.endsWith('_TIMEOUT'))
    const aborted =
      signal?.aborted ||
      name === 'AbortError' ||
      code === 'ABORT_ERR' ||
      code === 'UND_ERR_ABORTED'
    return {
      errorName: name,
      ...(code ? { errorCode: code } : {}),
      failureKind: timeout
        ? 'timeout'
        : aborted
          ? 'aborted'
          : code || name === 'TypeError' || name === 'FetchError'
            ? 'network'
            : 'error',
    }
  } catch {
    return { errorName: 'Error', failureKind: 'error' }
  }
}

// 控制字段仅接受短标识，避免调用方误把上游错误正文放入 reason/action 等字段。
function safeToken(value: string | undefined, fallback = 'unknown'): string {
  return value && /^[a-z0-9_.:-]{1,80}$/i.test(value) ? value : fallback
}

// Content-Type 仅记录媒体类型，不携带 boundary 等参数。
function mediaType(response?: Response): string | undefined {
  const value = response?.headers
    .get('content-type')
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase()
  return value && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value)
    ? value.slice(0, 100)
    : undefined
}

// 常规服务头只保留短标识字符，未知格式不把原始头值直接写入日志。
function safeHeader(value: string | null | undefined): string | undefined {
  if (value == null) return undefined
  return /^[a-z0-9 ._+()/:-]{1,120}$/i.test(value)
    ? value
    : 'present_unrecognized'
}

// Retry-After 只允许秒数或可识别日期，不回显任意字符串。
function retryAfter(value: string | null | undefined): string | undefined {
  if (value == null) return undefined
  if (/^\d{1,10}$/.test(value)) return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : 'present_unrecognized'
}

// 限频槽在任何 await 前占用，只保存时间和计数，避免跨请求持有响应或信号。
function claimSlot(key: string): number | undefined {
  const now = Date.now()
  const previous = rateSlots.get(key)
  if (
    previous &&
    now >= previous.lastLoggedAt &&
    now - previous.lastLoggedAt < LOG_INTERVAL_MS
  ) {
    previous.suppressed = Math.min(
      Number.MAX_SAFE_INTEGER,
      previous.suppressed + 1,
    )
    return undefined
  }
  if (previous) rateSlots.delete(key)
  else if (rateSlots.size >= MAX_RATE_KEYS) {
    const oldest = rateSlots.keys().next().value
    if (oldest !== undefined) rateSlots.delete(oldest)
  }
  rateSlots.set(key, { lastLoggedAt: now, suppressed: 0 })
  return previous?.suppressed ?? 0
}

// 取消和释放诊断 reader 不阻塞业务；异步取消失败也始终被观察并吞掉。
async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  let cancellation: Promise<void> | undefined
  try {
    cancellation = reader.cancel()
  } catch {
    // 流可能已出错或释放，仍尝试解除 reader 锁。
  }
  try {
    reader.releaseLock()
  } catch {
    // 锁已释放时无需额外处理。
  }
  try {
    await cancellation
  } catch {
    // 不允许取消失败产生未处理的 Promise 拒绝。
  }
}

// 仅消费已拒绝的 HTML/明确挑战；原流不可用时报告状态，不克隆或重新请求正文。
async function readPrefix(
  issue: UpstreamIssue,
  html: boolean,
  challenged: boolean,
): Promise<Prefix> {
  const base: Prefix = {
    prefixState: 'not_applicable',
    prefixBytes: 0,
    prefixLimitBytes: PREFIX_LIMIT,
    prefixTruncated: false,
  }
  if (issue.sampleBody === false) return { ...base, prefixState: 'disabled' }
  if (!issue.response || (!html && !challenged)) return base
  if (issue.body !== undefined) {
    const text = issue.body.slice(0, PREFIX_LIMIT + 1)
    const encoded = new TextEncoder().encode(text)
    const bytes = encoded.subarray(0, PREFIX_LIMIT)
    return {
      ...base,
      prefixState: bytes.length ? 'sampled' : 'empty',
      prefixBytes: bytes.length,
      prefixTruncated:
        issue.body.length > text.length || encoded.length > PREFIX_LIMIT,
      text: new TextDecoder().decode(bytes),
    }
  }
  if (issue.signal?.aborted) {
    return {
      ...base,
      prefixState: 'unavailable',
      prefixError: safeDiagnosticError(issue.signal.reason, issue.signal)
        .failureKind,
    }
  }
  if (issue.response.bodyUsed || issue.response.body?.locked) {
    return {
      ...base,
      prefixState: 'unavailable',
      prefixError: issue.response.bodyUsed ? 'body_used' : 'body_locked',
    }
  }
  if (!issue.response.body) return { ...base, prefixState: 'empty' }
  const reader = issue.response.body.getReader()
  const buffer = new Uint8Array(PREFIX_LIMIT)
  let size = 0
  let finished = false
  let truncated = false
  let prefixError: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const stopped = Symbol('prefix stopped')
  // 同一个截止覆盖整段读取，慢速分块不能不断延长 200ms 的诊断预算。
  const stop = new Promise<typeof stopped>((resolve) => {
    timer = setTimeout(() => {
      prefixError = 'timeout'
      resolve(stopped)
    }, PREFIX_TIMEOUT_MS)
    abort = () => {
      prefixError = safeDiagnosticError(
        issue.signal?.reason,
        issue.signal,
      ).failureKind
      resolve(stopped)
    }
    issue.signal?.addEventListener('abort', abort, { once: true })
    if (issue.signal?.aborted) abort()
  })
  try {
    while (true) {
      const result = await Promise.race([reader.read(), stop])
      if (result === stopped) {
        truncated = true
        break
      }
      if (result.done) {
        finished = true
        break
      }
      const bytes = result.value.subarray(0, PREFIX_LIMIT - size)
      buffer.set(bytes, size)
      size += bytes.byteLength
      if (bytes.byteLength < result.value.byteLength) {
        truncated = true
        break
      }
    }
  } catch {
    prefixError = issue.signal?.aborted
      ? safeDiagnosticError(issue.signal.reason, issue.signal).failureKind
      : 'read_failed'
    truncated = true
  } finally {
    clearTimeout(timer)
    if (abort) issue.signal?.removeEventListener('abort', abort)
    if (finished) reader.releaseLock()
    else void cancelReader(reader)
  }
  return {
    ...base,
    prefixState: size ? 'sampled' : prefixError ? 'unavailable' : 'empty',
    prefixBytes: size,
    prefixTruncated: truncated,
    ...(prefixError ? { prefixError } : {}),
    text: new TextDecoder().decode(buffer.subarray(0, size)),
  }
}

// 标题只作为短摘要；移除标签、常见实体和 URL 查询，并抹去当前请求的查询值。
function pageTitle(text: string, url: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(text)
  if (!match) return undefined
  let title = match[1]
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi,
      (entity, name: string) => {
        const named: Record<string, string> = {
          amp: '&',
          lt: '<',
          gt: '>',
          quot: '"',
          apos: "'",
        }
        const lower = name.toLowerCase()
        if (lower in named) return named[lower]
        const value = Number.parseInt(
          lower.slice(lower.startsWith('#x') ? 2 : 1),
          lower.startsWith('#x') ? 16 : 10,
        )
        return value >= 0 && value <= 0x10ffff
          ? String.fromCodePoint(value)
          : entity
      },
    )
  title = title.replace(/https?:\/\/[^\s<>"']+/gi, (value) =>
    safeDiagnosticUrl(value),
  )
  try {
    const target = new URL(url)
    const values = [...target.searchParams.values()]
    // 缓存接口把原请求放在 requestPath 内，错误标题也可能只回显其中某个参数值。
    const requestPath = target.searchParams.get('requestPath')
    if (requestPath) {
      values.push(...new URL(requestPath, target.origin).searchParams.values())
    }
    if (values.length > 32) return '[redacted]'
    for (const value of values) {
      if (!value) continue
      title = title
        .split(value)
        .join('[redacted]')
        .split(encodeURIComponent(value))
        .join('[redacted]')
    }
  } catch {
    return undefined
  }
  return (
    title
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || undefined
  )
}

// 信号只描述前缀中观察到的特征，不据 Server 或 CDN 头判断挑战提供商。
function challengeSignals(text: string, challenged: boolean): string[] {
  const signals: string[] = []
  if (challenged) signals.push('cf_mitigated')
  if (/\/cdn-cgi\/challenge-platform\/|challenges\.cloudflare\.com/i.test(text))
    signals.push('cloudflare_script')
  if (/proof[\s_-]*of[\s_-]*work|\bkgl_pow_challenge\b/i.test(text))
    signals.push('proof_of_work')
  if (/\bcaptcha\b|g-recaptcha|hcaptcha|h-captcha|cf-turnstile/i.test(text))
    signals.push('captcha')
  if (
    /enable\s+javascript|javascript\s+(?:is\s+)?required|requires?\s+javascript/i.test(
      text,
    )
  )
    signals.push('javascript_required')
  if (
    /security\s+verification|verifying\s+browser\s+work|checking\s+your\s+browser/i.test(
      text,
    )
  )
    signals.push('security_verification')
  return signals
}

// 统一记录上游异常；限频、取样或日志系统失败都不改变调用方的换源和 TTL 决策。
export async function reportUpstreamIssue(
  issue: UpstreamIssue,
): Promise<boolean> {
  try {
    const error =
      issue.error === undefined && issue.response
        ? undefined
        : safeDiagnosticError(issue.error, issue.signal)
    // 缓存聚合已被其他赢家取消的探测不构成上游故障。
    if (issue.stage === 'cache' && error?.failureKind === 'aborted')
      return false
    const url = safeDiagnosticUrl(issue.url)
    const upstream = url === 'invalid' ? 'invalid' : new URL(url).origin
    const type = mediaType(issue.response)
    const cfMitigated = issue.response?.headers
      .get('cf-mitigated')
      ?.trim()
      .toLowerCase()
    const challenged = cfMitigated === 'challenge'
    const reason = challenged ? 'challenge_header' : safeToken(issue.reason)
    const key = `${upstream}|${issue.stage}|${reason}|${issue.response?.status ?? error?.errorCode ?? `${error?.errorName}:${error?.failureKind}`}`
    const suppressed = claimSlot(key)
    if (suppressed === undefined) return false

    const prefix = await readPrefix(
      issue,
      type === 'text/html' || type === 'application/xhtml+xml',
      challenged,
    )
    const { text = '', ...prefixMetadata } = prefix
    const requestId = issue.requestId ?? getCurrentRequestId()
    const location = issue.response?.headers.get('location')
    let safeLocation: string | undefined
    if (location != null) {
      try {
        safeLocation = safeDiagnosticUrl(
          new URL(location, issue.response?.url || issue.url).href,
        )
      } catch {
        safeLocation = 'invalid'
      }
    }
    upstreamLogger.warn(
      issue.response ? 'upstream response rejected' : 'upstream request failed',
      {
        event: issue.response
          ? 'upstream.response_rejected'
          : 'upstream.request_failed',
        runtime: runtime ?? 'unknown',
        stage: issue.stage,
        reason,
        action: safeToken(issue.action),
        url,
        upstream,
        upstreamPath: url === 'invalid' ? 'invalid' : new URL(url).pathname,
        responseUrl: issue.response
          ? safeDiagnosticUrl(issue.response.url || issue.url)
          : undefined,
        ...(requestId
          ? { requestId: safeToken(requestId) }
          : {
              diagnosticId: `${Date.now().toString(36)}-${(++diagnosticSequence).toString(36)}`,
            }),
        ...(issue.method ? { method: safeToken(issue.method) } : {}),
        ...(Number.isFinite(issue.durationMs)
          ? { durationMs: issue.durationMs }
          : {}),
        ...(Number.isFinite(issue.ttlSeconds)
          ? { ttlSeconds: issue.ttlSeconds }
          : {}),
        ...(issue.response
          ? {
              status: issue.response.status,
              contentType: type,
              cfMitigated: cfMitigated ? safeToken(cfMitigated) : undefined,
              cfRay: safeHeader(issue.response.headers.get('cf-ray')),
              server: safeHeader(issue.response.headers.get('server')),
              retryAfter: retryAfter(issue.response.headers.get('retry-after')),
              location: safeLocation,
            }
          : {}),
        ...(error ?? {}),
        ...prefixMetadata,
        title: pageTitle(text, issue.url),
        challengeSignals: challengeSignals(text, challenged),
        suppressedSinceLastLog: suppressed,
      },
    )
    if (issue.trace) {
      issue.trace.logged = true
      // Promise.any 的结果可能先返回；只通知同一请求的回调补齐最终摘要。
      try {
        issue.trace.onLogged?.()
      } catch {
        // 摘要失败不能把已写出的诊断改报为失败，更不能影响业务处理。
      }
    }
    return true
  } catch {
    return false
  }
}
