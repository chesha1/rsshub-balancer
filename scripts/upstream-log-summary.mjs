import { StringDecoder } from 'node:string_decoder'

const MAX_GROUPS = 512
const OUTPUT_LIMIT = 50
const MAX_LINE_CHARS = 256 * 1024
const EVENTS = new Set([
  'upstream.response_rejected',
  'upstream.request_failed',
  'upstream.fetch',
  'upstream.health_result',
  'upstream.cache_status_result',
  'cron.refresh',
])
const TOKEN = /^[A-Za-z0-9_.:-]+$/
const DOCKER_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))\s+/
const USAGE = 'Usage: pnpm logs:upstream [--request-id <id>] < logs.jsonl'

// 参数仅用于关联请求；拒绝无效输入时不把参数原文写到终端。
export function parseOptions(args = process.argv.slice(2)) {
  if (args.length === 0) return {}
  if (args.length === 1 && args[0] === '--help') return { help: true }
  if (
    args.length === 2 &&
    args[0] === '--request-id' &&
    safeToken(args[1], 128)
  ) {
    return { requestId: args[1] }
  }
  throw new Error('invalid_arguments')
}

// 逐块切行并丢弃超长行，避免把整个日志文件或异常巨大的单行留在内存。
async function* inputLines(input) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let oversized = false
  for await (const chunk of input) {
    const text = decoder.write(
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
    )
    let start = 0
    for (let index = 0; index <= text.length; index++) {
      if (index !== text.length && text[index] !== '\n') continue
      if (!oversized) {
        const part = text.slice(start, index)
        if (pending.length + part.length > MAX_LINE_CHARS) {
          pending = ''
          oversized = true
        } else {
          pending += part
        }
      }
      if (index < text.length) {
        yield oversized ? { oversized: true } : { text: pending }
        pending = ''
        oversized = false
      }
      start = index + 1
    }
  }
  pending += decoder.end()
  if (oversized || pending.length > MAX_LINE_CHARS) yield { oversized: true }
  else if (pending) yield { text: pending }
}

// 固定代号和请求 ID 只接受短的可打印标识，不接收任意错误信息或对象。
function safeToken(value, limit = 80) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    TOKEN.test(value)
    ? value
    : undefined
}

// URL 只保留 HTTP(S) 的源和路径，查询参数、片段及用户信息不会进入输出。
function safeUrl(value, allowHost = false) {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  try {
    const input =
      allowHost && !value.includes('://') ? `https://${value}` : value
    const url = new URL(input)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `${url.origin}${url.pathname}`
  } catch {
    return undefined
  }
}

// 路径字段可能来自含查询串的旧日志，统一按 URL 解析后仅输出 pathname。
function safePath(value) {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  try {
    return new URL(value, 'https://log.invalid').pathname
  } catch {
    return undefined
  }
}

// 标题只作为短例子展示，同时清理控制字符、URL 凭据和疑似凭据字段。
function safeTitle(value) {
  if (typeof value !== 'string') return undefined
  const title = value
    .slice(0, 1024)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => safeUrl(url) ?? '[url]')
    .replace(/\b(?:set-cookie|cookie|authorization)\s*[:=].*/gi, '[redacted]')
    .replace(/\?[^\s<>"']*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  return title || undefined
}

// Content-Type 仅输出媒体类型，忽略可能携带任意值的参数。
function contentType(value) {
  if (typeof value !== 'string') return undefined
  const type = value.split(';', 1)[0].trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)
    ? type.slice(0, 120)
    : undefined
}

// 只接受非负安全整数，避免非法次数或超大数值破坏聚合结果。
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

// 日期只接受明确时间戳；无法解释的原文不回显。
function timestamp(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (
    typeof value === 'string' &&
    (value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value))
  )
    return undefined
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 8.64e15) return undefined
  return new Date(parsed).toISOString()
}

// 兼容 LogTape properties、扁平 JSON 和 Docker --timestamps 前缀。
function parseLine(line) {
  const prefix = DOCKER_TIMESTAMP.exec(line)
  const source = prefix ? line.slice(prefix[0].length) : line
  const record = JSON.parse(source)
  if (!record || typeof record !== 'object' || Array.isArray(record))
    return undefined
  const properties = record.properties
  const fields =
    properties && typeof properties === 'object' && !Array.isArray(properties)
      ? properties
      : record
  return {
    fields,
    time:
      timestamp(record['@timestamp'] ?? record.timestamp) ??
      timestamp(prefix?.[1]),
    level: safeToken(record.level, 20),
  }
}

// 只复制诊断白名单；原始 message、error、headers、Cookie 和未知对象均不展开。
export function safeEvent(record) {
  const fields = record.fields
  if (!EVENTS.has(fields.event)) return undefined
  const event = fields.event
  const inferredStage =
    event === 'upstream.fetch'
      ? 'feed_result'
      : event === 'upstream.health_result'
        ? 'health_result'
        : event === 'upstream.cache_status_result'
          ? 'cache_status_result'
          : event === 'cron.refresh'
            ? 'health_refresh'
            : 'unknown'
  const upstream = safeUrl(fields.upstream, true)
  const result = {
    timestamp: record.time,
    level: record.level,
    event,
    runtime: safeToken(fields.runtime, 24) ?? 'unknown',
    stage: safeToken(fields.stage, 40) ?? inferredStage,
    upstream,
    upstreamHost: upstream ? new URL(upstream).host : undefined,
    url: safeUrl(fields.url),
    path: safePath(
      fields.upstreamPath ??
        fields.path ??
        fields.requestPath ??
        fields.pathname,
    ),
    requestPath: safePath(fields.requestPath),
    responseUrl: safeUrl(fields.responseUrl),
    location: safeUrl(fields.location),
    contentType: contentType(fields.contentType),
    reason: safeToken(fields.reason),
    outcome: safeToken(fields.outcome),
    status:
      Number.isInteger(fields.status) &&
      fields.status >= 100 &&
      fields.status <= 599
        ? fields.status
        : undefined,
    requestId: safeToken(fields.requestId, 128),
    diagnosticId: safeToken(fields.diagnosticId, 128),
    pageTitle: safeTitle(fields.pageTitle ?? fields.title),
    cfRay: safeToken(fields.cfRay, 100),
    cfMitigated: safeToken(fields.cfMitigated, 40),
    suppressedSinceLastLog: count(fields.suppressedSinceLastLog),
  }
  for (const name of ['finalUpstreamHost', 'selectedUpstreamHost']) {
    result[name] = safeUrl(fields[name], true)
  }
  for (const name of [
    'bodyReadStatus',
    'bodyReadError',
    'bodyRead',
    'requestFormat',
    'finalAttemptKind',
    'prefixState',
    'prefixError',
    'action',
    'errorName',
    'errorCode',
    'failureKind',
    'method',
    'retryAfter',
  ]) {
    const value = safeToken(fields[name])
    if (value) result[name] = value
  }
  for (const name of [
    'diagnosticsLogged',
    'bodyTruncated',
    'cacheHit',
    'fallbackUsed',
    'prefixTruncated',
  ]) {
    if (typeof fields[name] === 'boolean') result[name] = fields[name]
  }
  for (const name of [
    'bodyBytes',
    'ttlSeconds',
    'attemptCount',
    'retryCount',
    'healthyUpstreamCount',
    'failedUpstreamCount',
    'probeCount',
    'prefixBytes',
    'prefixLimitBytes',
  ]) {
    if (Number.isSafeInteger(fields[name]) && fields[name] >= 0)
      result[name] = fields[name]
  }
  if (
    typeof fields.durationMs === 'number' &&
    Number.isFinite(fields.durationMs) &&
    fields.durationMs >= 0
  )
    result.durationMs = fields.durationMs
  for (const name of ['challengeSignals', 'requestQueryKeys']) {
    if (Array.isArray(fields[name])) {
      result[name] = fields[name]
        .slice(0, 16)
        .map((value) => safeToken(value))
        .filter(Boolean)
    }
  }
  if (fields.bodyRead && typeof fields.bodyRead === 'object') {
    const body = fields.bodyRead
    result.bodyRead = {
      status: safeToken(body.status),
      error: safeToken(body.error),
      bytes:
        Number.isSafeInteger(body.bytes) && body.bytes >= 0
          ? body.bytes
          : undefined,
      truncated:
        typeof body.truncated === 'boolean' ? body.truncated : undefined,
    }
  }
  return result
}

// 每类只留少量去重例子，标题、Request ID 等高基数字段不扩张分组数量。
function example(values, value, limit = 3) {
  if (value !== undefined && values.length < limit && !values.includes(value))
    values.push(value)
}

// 首末时间按时间戳比较，保留输入乱序或混合多个运行时日志时的实际范围。
function updateTime(target, time) {
  if (!time) return
  if (!target.firstSeenAt || time < target.firstSeenAt)
    target.firstSeenAt = time
  if (!target.lastSeenAt || time > target.lastSeenAt) target.lastSeenAt = time
}

// 累加实际看到的日志和日志明确报告的抑制数；溢出时标记饱和而不产生不精确整数。
function addCounts(target, event) {
  target.loggedEvents += 1
  const total = target.reportedSuppressed + event.suppressedSinceLastLog
  if (!Number.isSafeInteger(total + target.loggedEvents)) {
    target.countsSaturated = true
  }
  target.reportedSuppressed = Math.min(
    Number.MAX_SAFE_INTEGER - target.loggedEvents,
    total,
  )
  target.observedAndReportedEvents =
    target.loggedEvents + target.reportedSuppressed
}

// 有界聚合一条诊断；超过 512 个分组的事件只累加到 overflow，不继续记住新键。
function aggregate(groups, overflow, event) {
  const dimensions = {
    runtime: event.runtime,
    upstream: event.upstream ?? 'aggregate_or_unknown',
    stage: event.stage,
    reason: event.reason ?? event.outcome ?? event.event,
    status: event.status ?? 'unknown',
  }
  const key = JSON.stringify(dimensions)
  let group = groups.get(key)
  if (!group) {
    if (groups.size >= MAX_GROUPS) {
      addCounts(overflow, event)
      updateTime(overflow, event.timestamp)
      return
    }
    group = {
      ...dimensions,
      upstreamHost: event.upstreamHost,
      loggedEvents: 0,
      reportedSuppressed: 0,
      observedAndReportedEvents: 0,
      examples: {
        pageTitles: [],
        challengeSignals: [],
        requestIds: [],
        cfRays: [],
        paths: [],
      },
    }
    groups.set(key, group)
  }
  addCounts(group, event)
  updateTime(group, event.timestamp)
  example(group.examples.pageTitles, event.pageTitle)
  example(group.examples.requestIds, event.requestId)
  example(group.examples.cfRays, event.cfRay)
  example(group.examples.paths, event.requestPath ?? event.path)
  for (const signal of event.challengeSignals ?? [])
    example(group.examples.challengeSignals, signal, 5)
}

// 流式处理输入；请求模式保留最后 50 条安全事件，便于看到重试后的最终结果。
export async function summarize(input, options = {}) {
  const counts = {
    inputLines: 0,
    emptyLines: 0,
    nonJsonLines: 0,
    oversizedLines: 0,
    unrecognizedRecords: 0,
    relevantEvents: 0,
    matchingEvents: 0,
  }
  const groups = new Map()
  const overflow = {
    loggedEvents: 0,
    reportedSuppressed: 0,
    observedAndReportedEvents: 0,
  }
  const events = []
  const range = {}
  for await (const line of inputLines(input)) {
    counts.inputLines += 1
    if (line.oversized) {
      counts.oversizedLines += 1
      continue
    }
    if (!line.text.trim()) {
      counts.emptyLines += 1
      continue
    }
    let parsed
    try {
      parsed = parseLine(line.text.trim())
    } catch {
      counts.nonJsonLines += 1
      continue
    }
    const event = parsed ? safeEvent(parsed) : undefined
    if (!event) {
      counts.unrecognizedRecords += 1
      continue
    }
    counts.relevantEvents += 1
    if (options.requestId && event.requestId !== options.requestId) continue
    counts.matchingEvents += 1
    updateTime(range, event.timestamp)
    if (options.requestId) {
      if (events.length === OUTPUT_LIMIT) events.shift()
      events.push(event)
    } else {
      aggregate(groups, overflow, event)
    }
  }
  const result = {
    mode: options.requestId ? 'request' : 'overview',
    coverage: 'provided_logs_and_reported_suppression_only',
    countUnit: 'log_events_not_unique_requests_or_complete_traffic',
    counts,
    ...range,
  }
  if (options.requestId) {
    return {
      ...result,
      requestId: options.requestId,
      eventOrder: 'last_50_in_input_order',
      eventsOmitted: counts.matchingEvents - events.length,
      events,
    }
  }
  const sorted = [...groups.values()].sort(
    (left, right) =>
      right.observedAndReportedEvents - left.observedAndReportedEvents ||
      (right.lastSeenAt ?? '').localeCompare(left.lastSeenAt ?? ''),
  )
  return {
    ...result,
    groupsTracked: groups.size,
    groupsNotShown: Math.max(0, groups.size - OUTPUT_LIMIT),
    ranking: 'top_50_within_first_512_distinct_groups',
    overflow,
    groups: sorted.slice(0, OUTPUT_LIMIT),
  }
}

// stdin 和参数错误只输出固定代号，不复述日志原文或未知异常对象。
async function main() {
  let options
  try {
    options = parseOptions()
  } catch {
    process.stderr.write(
      `${JSON.stringify({ error: 'invalid_arguments', usage: USAGE })}\n`,
    )
    process.exitCode = 1
    return
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  try {
    const result = await summarize(process.stdin, options)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch {
    process.stderr.write(
      `${JSON.stringify({ error: 'input_processing_failed' })}\n`,
    )
    process.exitCode = 1
  }
}

// Node 26 支持文件与 stdin 入口，模块导入只用于离线核验而不自动读取输入。
if (import.meta.main) await main()
