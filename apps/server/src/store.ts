import { createClient } from '@redis/client'
import { Redis } from '@upstash/redis/cloudflare'
import { errorProps, storeLogger } from './log'

const INSTANCES_KEY = 'instances'
const REDIS_COMMAND_TIMEOUT_MS = 2000
const REDIS_SLOW_COMMAND_LOG_MS = 500
const REDIS_HTTP_PARSE_ERROR_PREFIX = 'Unable to parse response body: '

type StateStoreBackend = 'kv' | 'redis' | 'redis-http'
type RedisClientCreateReason = 'fresh_command'

type RedisClientDestroyReason =
  | 'command_finished'
  | 'connect_failed'
  | 'command_failed'
  | 'command_timeout'

type StateStoreEnv = {
  KV: KVNamespace
  STATE_STORE_BACKEND?: string
  VALKEY_URL?: string
  REDIS_HTTP_URL?: string
  REDIS_HTTP_TOKEN?: string
  UPSTASH_REDIS_REST_URL?: string
  UPSTASH_REDIS_REST_TOKEN?: string
}

type RedisSetOptions = {
  expiration?: {
    type: 'EX'
    value: number
  }
}

type RedisClient = {
  isReady: boolean
  connect(): Promise<RedisClient>
  destroy(): void
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: RedisSetOptions): Promise<unknown>
  mGet(keys: readonly string[]): Promise<Array<string | null>>
}

type RedisClientWithEvents = RedisClient & {
  on(event: 'error', listener: (error: Error) => void): void
}

type RedisClientDiagnostics = {
  generation: number
  createdAtMs: number
  readyAtMs?: number
  prepareDurationMs?: number
  commandCount: number
  timedOutCommandCount: number
  commandInFlight: number
  lastOperation?: string
  lastCommandStartedAtMs?: number
}

type RedisHttpConfig = {
  url: string
  token: string
  source: 'redis_http' | 'upstash_env'
}

let redisClientGeneration = 0
let redisHttpClient: Redis | undefined
let redisHttpClientUrl: string | undefined
let redisHttpClientToken: string | undefined

const redisClientDiagnostics = new WeakMap<
  RedisClient,
  RedisClientDiagnostics
>()

class RedisCommandTimeoutError extends Error {
  // 构造可被日志识别的 Redis 单命令超时错误。
  constructor(operation: string, timeoutMs: number) {
    super(`redis ${operation} command timed out after ${timeoutMs}ms`)
    this.name = 'RedisCommandTimeoutError'
  }
}

export type StateStore = {
  getInstances(): Promise<string[] | undefined>
  setInstances(upstreams: string[]): Promise<void>
  getFailedUpstreams(
    upstreams: readonly string[],
    pathname: string,
  ): Promise<Set<string>>
  markUpstreamFailed(
    upstream: string,
    pathname: string,
    ttlSeconds: number,
  ): Promise<void>
}

// 解析实例列表，兼容 Redis 原始 JSON 字符串和 HTTP SDK 已反序列化后的数组。
function parseInstances(raw: string | string[] | null): string[] | undefined {
  if (!raw) return undefined

  if (Array.isArray(raw)) {
    if (raw.length > 0) return raw
    return undefined
  }

  try {
    const list = JSON.parse(raw) as string[]
    if (Array.isArray(list) && list.length > 0) return list
  } catch {}

  return undefined
}

// 统一生成失败标记 key；动态输入段先编码，避免冒号破坏 key 分隔语义。
function failedUpstreamKey(upstream: string, pathname: string): string {
  return `fail:${encodeURIComponent(upstream)}:${encodeURIComponent(pathname)}`
}

// 规范化状态存储后端配置；未知值回退到 KV，并写日志提示配置问题。
function getStateStoreBackend(
  rawBackend: string | undefined,
): StateStoreBackend {
  if (
    rawBackend === 'redis' ||
    rawBackend === 'redis-http' ||
    rawBackend === 'kv'
  ) {
    return rawBackend
  }
  if (rawBackend === undefined || rawBackend === '') return 'kv'

  storeLogger.warn('unknown state store backend; falling back to kv', {
    event: 'state_store.backend',
    outcome: 'fallback_kv',
    configuredBackend: rawBackend,
  })
  return 'kv'
}

// 读取 Redis HTTP proxy 配置，并兼容 Upstash 官方环境变量名称以方便后续切换。
function getRedisHttpConfig(env: StateStoreEnv): RedisHttpConfig {
  const url = env.REDIS_HTTP_URL ?? env.UPSTASH_REDIS_REST_URL
  const token = env.REDIS_HTTP_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    throw new Error(
      'REDIS_HTTP_URL and REDIS_HTTP_TOKEN are required when STATE_STORE_BACKEND=redis-http',
    )
  }

  return {
    url,
    token,
    source: env.REDIS_HTTP_URL ? 'redis_http' : 'upstash_env',
  }
}

// 复用轻量 HTTP Redis client；它不维护 Redis TCP 连接，只封装到 proxy 的 fetch 调用。
function getRedisHttpClient(config: RedisHttpConfig): Redis {
  if (
    redisHttpClient &&
    redisHttpClientUrl === config.url &&
    redisHttpClientToken === config.token
  ) {
    return redisHttpClient
  }

  redisHttpClient = new Redis({
    url: config.url,
    token: config.token,
    automaticDeserialization: false,
    enableTelemetry: false,
    readYourWrites: false,
    responseEncoding: false,
    retry: { retries: 0 },
    signal: () => AbortSignal.timeout(REDIS_COMMAND_TIMEOUT_MS),
  })
  redisHttpClientUrl = config.url
  redisHttpClientToken = config.token

  storeLogger.info('redis http client created', {
    event: 'state_store.redis_http.client',
    outcome: 'created',
    configSource: config.source,
    timeoutMs: REDIS_COMMAND_TIMEOUT_MS,
  })

  return redisHttpClient
}

// 判断 HTTP Redis 请求是否被超时信号中止，用于把日志 outcome 标成 timed_out。
function isRedisHttpTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.name === 'TimeoutError'
}

// 展开 HTTP Redis SDK 对非 JSON 错误响应的包装，避免把 proxy 502 误读成业务 JSON 解析失败。
function redisHttpErrorProps(error: unknown): Record<string, unknown> {
  const props = errorProps(error)
  if (!(error instanceof Error)) return props
  if (error.name !== 'UpstashJSONParseError') return props
  if (!error.message.startsWith(REDIS_HTTP_PARSE_ERROR_PREFIX)) return props

  const responseBodyPreview = error.message
    .slice(REDIS_HTTP_PARSE_ERROR_PREFIX.length)
    .trim()
  const statusCodeMatch = /^error code:\s*(\d{3})\b/i.exec(responseBodyPreview)

  return {
    ...props,
    redisHttpErrorKind: 'non_json_error_response',
    responseBodyPreview,
    ...(statusCodeMatch ? { statusCode: Number(statusCodeMatch[1]) } : {}),
  }
}

// 给 Redis HTTP 命令记录与直连 Redis 相同粒度的耗时和失败日志。
async function runRedisHttpCommand<T>(
  operation: string,
  runCommand: () => Promise<T>,
): Promise<T> {
  const startedAtMs = Date.now()
  storeLogger.debug('redis http command started', {
    event: 'state_store.redis_http.command',
    outcome: 'started',
    operation,
    timeoutMs: REDIS_COMMAND_TIMEOUT_MS,
  })

  try {
    const result = await runCommand()
    const durationMs = Date.now() - startedAtMs
    if (durationMs >= REDIS_SLOW_COMMAND_LOG_MS) {
      storeLogger.info('redis http slow command succeeded', {
        event: 'state_store.redis_http.command',
        outcome: 'succeeded',
        slow: true,
        operation,
        durationMs,
        timeoutMs: REDIS_COMMAND_TIMEOUT_MS,
      })
    }
    return result
  } catch (error) {
    const timedOut = isRedisHttpTimeout(error)
    const diagnosticProps = redisHttpErrorProps(error)
    const nonJsonError =
      diagnosticProps.redisHttpErrorKind === 'non_json_error_response'
    storeLogger.warn(
      timedOut
        ? 'redis http command timed out; falling back'
        : nonJsonError
          ? 'redis http proxy returned non-json error response'
          : 'redis http command failed',
      {
        event: 'state_store.redis_http.command',
        outcome: timedOut ? 'timed_out' : 'failed',
        operation,
        durationMs: Date.now() - startedAtMs,
        timeoutMs: REDIS_COMMAND_TIMEOUT_MS,
        ...diagnosticProps,
      },
    )
    throw error
  }
}

// 汇总当前 Redis client 的生命周期计数，保持各类日志字段命名一致。
function redisClientDiagnosticProps(
  client: RedisClient,
  diagnostics = redisClientDiagnostics.get(client),
): Record<string, unknown> {
  const nowMs = Date.now()
  return {
    clientGeneration: diagnostics?.generation,
    ageMs: diagnostics ? nowMs - diagnostics.createdAtMs : undefined,
    readyAgeMs:
      diagnostics?.readyAtMs === undefined
        ? undefined
        : nowMs - diagnostics.readyAtMs,
    prepareDurationMs: diagnostics?.prepareDurationMs,
    commandCount: diagnostics?.commandCount,
    timedOutCommandCount: diagnostics?.timedOutCommandCount,
    commandInFlight: diagnostics?.commandInFlight,
    lastOperation: diagnostics?.lastOperation,
    lastCommandAgeMs:
      diagnostics?.lastCommandStartedAtMs === undefined
        ? undefined
        : nowMs - diagnostics.lastCommandStartedAtMs,
    isReady: client.isReady,
  }
}

// 为新建 Redis client 分配 generation，并记录创建时的诊断基线。
function registerRedisClientDiagnostics(
  client: RedisClient,
  reason: RedisClientCreateReason,
): RedisClientDiagnostics {
  const diagnostics: RedisClientDiagnostics = {
    generation: redisClientGeneration + 1,
    createdAtMs: Date.now(),
    commandCount: 0,
    timedOutCommandCount: 0,
    commandInFlight: 0,
  }
  redisClientGeneration = diagnostics.generation
  redisClientDiagnostics.set(client, diagnostics)

  storeLogger.info('redis client created', {
    event: 'state_store.redis.client',
    outcome: 'created',
    reason,
    ...redisClientDiagnosticProps(client, diagnostics),
  })

  return diagnostics
}

// 创建一个 Redis 客户端实例，集中约束边缘请求路径上的连接和排队行为。
function createRedisClient(valkeyUrl: string): RedisClient {
  const client = createClient({
    url: valkeyUrl,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 32,
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: false,
    },
  }) as unknown as RedisClientWithEvents

  // node-redis 的 error 事件必须被消费，否则后台连接错误可能变成未处理异常。
  client.on('error', (error: Error) => {
    storeLogger.warn('redis client emitted an error', {
      event: 'state_store.redis.client',
      outcome: 'error',
      ...redisClientDiagnosticProps(client),
      ...errorProps(error),
    })
  })

  return client
}

// 销毁单次 Redis 操作使用的短连接，确保直连 Redis 不跨命令复用 client。
function destroyRedisClient(
  client: RedisClient,
  reason: RedisClientDestroyReason,
  operation?: string,
): void {
  try {
    client.destroy()
    storeLogger.info('redis client destroyed', {
      event: 'state_store.redis.client',
      outcome: 'destroyed',
      reason,
      operation,
      ...redisClientDiagnosticProps(client),
    })
  } catch (error) {
    storeLogger.warn('redis client destroy failed', {
      event: 'state_store.redis.client',
      outcome: 'destroy_failed',
      reason,
      operation,
      ...redisClientDiagnosticProps(client),
      ...errorProps(error),
    })
  }
}

// 给单次 Redis 命令加短超时，把挂起命令转换为可降级的异常。
async function runRedisCommandWithTimeout<T>(
  client: RedisClient,
  operation: string,
  runCommand: () => Promise<T>,
  prepareDurationMs: number,
): Promise<T> {
  const diagnostics = redisClientDiagnostics.get(client)
  const startedAtMs = Date.now()
  const clientReadyAtStart = client.isReady
  const isFirstCommandOnClient = diagnostics?.commandCount === 0
  if (diagnostics) {
    diagnostics.commandCount += 1
    diagnostics.commandInFlight += 1
    diagnostics.lastOperation = operation
    diagnostics.lastCommandStartedAtMs = startedAtMs
  }

  storeLogger.debug('redis command started', {
    event: 'state_store.redis.command',
    outcome: 'started',
    operation,
    prepareDurationMs,
    timeoutMs: REDIS_COMMAND_TIMEOUT_MS,
    clientReadyAtStart,
    isFirstCommandOnClient,
    ...redisClientDiagnosticProps(client, diagnostics),
  })

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true
      if (diagnostics) diagnostics.timedOutCommandCount += 1
      const error = new RedisCommandTimeoutError(
        operation,
        REDIS_COMMAND_TIMEOUT_MS,
      )
      const durationMs = Date.now() - startedAtMs
      storeLogger.warn('redis command timed out; falling back', {
        event: 'state_store.redis.command',
        outcome: 'timed_out',
        operation,
        prepareDurationMs,
        durationMs,
        timeoutMs: REDIS_COMMAND_TIMEOUT_MS,
        clientReadyAtStart,
        isFirstCommandOnClient,
        ...redisClientDiagnosticProps(client, diagnostics),
        ...errorProps(error),
      })
      reject(error)
    }, REDIS_COMMAND_TIMEOUT_MS)
  })

  try {
    const result = await Promise.race([runCommand(), timeoutPromise])
    const durationMs = Date.now() - startedAtMs
    if (durationMs >= REDIS_SLOW_COMMAND_LOG_MS) {
      storeLogger.info('redis slow command succeeded', {
        event: 'state_store.redis.command',
        outcome: 'succeeded',
        slow: true,
        operation,
        prepareDurationMs,
        durationMs,
        timeoutMs: REDIS_COMMAND_TIMEOUT_MS,
        clientReadyAtStart,
        isFirstCommandOnClient,
        ...redisClientDiagnosticProps(client, diagnostics),
      })
    }
    return result
  } catch (error) {
    if (!timedOut) {
      storeLogger.warn('redis command failed', {
        event: 'state_store.redis.command',
        outcome: 'failed',
        operation,
        prepareDurationMs,
        durationMs: Date.now() - startedAtMs,
        timeoutMs: REDIS_COMMAND_TIMEOUT_MS,
        clientReadyAtStart,
        isFirstCommandOnClient,
        ...redisClientDiagnosticProps(client, diagnostics),
        ...errorProps(error),
      })
    }
    throw error
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    if (diagnostics) {
      diagnostics.commandInFlight = Math.max(0, diagnostics.commandInFlight - 1)
    }
  }
}

// 为单条 Redis 操作创建短连接，按 connect -> command -> destroy 完成完整生命周期。
async function runRedisCommandWithFreshClient<T>(
  valkeyUrl: string | undefined,
  operation: string,
  runCommand: (client: RedisClient) => Promise<T>,
): Promise<T> {
  if (!valkeyUrl) {
    throw new Error('VALKEY_URL is required when STATE_STORE_BACKEND=redis')
  }

  const client = createRedisClient(valkeyUrl)
  const createReason: RedisClientCreateReason = 'fresh_command'
  const diagnostics = registerRedisClientDiagnostics(client, createReason)
  const connectStartedAtMs = Date.now()
  let destroyReason: RedisClientDestroyReason = 'command_finished'
  let connected = false

  storeLogger.debug('redis connect started', {
    event: 'state_store.redis.connect',
    outcome: 'started',
    reason: createReason,
    operation,
    ...redisClientDiagnosticProps(client, diagnostics),
  })

  try {
    await client.connect()
    connected = true
    diagnostics.readyAtMs = Date.now()
    const prepareDurationMs = diagnostics.readyAtMs - connectStartedAtMs
    diagnostics.prepareDurationMs = prepareDurationMs
    storeLogger.debug('redis connect succeeded', {
      event: 'state_store.redis.connect',
      outcome: 'succeeded',
      reason: createReason,
      operation,
      durationMs: prepareDurationMs,
      prepareDurationMs,
      ...redisClientDiagnosticProps(client, diagnostics),
    })
    storeLogger.debug('redis client ready', {
      event: 'state_store.redis.client',
      outcome: 'ready',
      reason: createReason,
      operation,
      prepareDurationMs,
      ...redisClientDiagnosticProps(client, diagnostics),
    })

    try {
      return await runRedisCommandWithTimeout(
        client,
        operation,
        () => runCommand(client),
        prepareDurationMs,
      )
    } catch (error) {
      destroyReason =
        error instanceof RedisCommandTimeoutError
          ? 'command_timeout'
          : 'command_failed'
      throw error
    }
  } catch (error) {
    if (!connected) {
      destroyReason = 'connect_failed'
      storeLogger.warn('redis connect failed', {
        event: 'state_store.redis.connect',
        outcome: 'failed',
        reason: createReason,
        operation,
        durationMs: Date.now() - connectStartedAtMs,
        ...redisClientDiagnosticProps(client, diagnostics),
        ...errorProps(error),
      })
    }
    throw error
  } finally {
    destroyRedisClient(client, destroyReason, operation)
  }
}

class KvStateStore implements StateStore {
  constructor(private readonly kv: KVNamespace) {}

  // 从 Cloudflare KV 读取上游实例列表。
  async getInstances(): Promise<string[] | undefined> {
    const raw = await this.kv.get(INSTANCES_KEY)
    return parseInstances(raw)
  }

  // 将上游实例列表整体写入 Cloudflare KV。
  async setInstances(upstreams: string[]): Promise<void> {
    await this.kv.put(INSTANCES_KEY, JSON.stringify(upstreams))
  }

  // 并行读取当前路由在 Cloudflare KV 中的失败标记。
  async getFailedUpstreams(
    upstreams: readonly string[],
    pathname: string,
  ): Promise<Set<string>> {
    const keys = upstreams.map((upstream) =>
      failedUpstreamKey(upstream, pathname),
    )
    const values = await Promise.all(keys.map((key) => this.kv.get(key)))
    const failedUpstreams = new Set<string>()

    for (const [index, value] of values.entries()) {
      if (value) failedUpstreams.add(upstreams[index])
    }
    return failedUpstreams
  }

  // 将某个上游在当前路由上的失败标记写入 Cloudflare KV，并设置短 TTL。
  async markUpstreamFailed(
    upstream: string,
    pathname: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.kv.put(failedUpstreamKey(upstream, pathname), '1', {
      expirationTtl: ttlSeconds,
    })
  }
}

class RedisStateStore implements StateStore {
  constructor(private readonly valkeyUrl: string | undefined) {}

  // 从 Redis / Aiven Valkey 读取上游实例列表。
  async getInstances(): Promise<string[] | undefined> {
    const raw = await runRedisCommandWithFreshClient(
      this.valkeyUrl,
      'get instances',
      (client) => client.get(INSTANCES_KEY),
    )
    return parseInstances(raw)
  }

  // 将上游实例列表整体写入 Redis / Aiven Valkey。
  async setInstances(upstreams: string[]): Promise<void> {
    await runRedisCommandWithFreshClient(
      this.valkeyUrl,
      'set instances',
      (client) => client.set(INSTANCES_KEY, JSON.stringify(upstreams)),
    )
  }

  // 使用 MGET 一次性读取当前路由在 Redis / Aiven Valkey 中的失败标记。
  async getFailedUpstreams(
    upstreams: readonly string[],
    pathname: string,
  ): Promise<Set<string>> {
    if (upstreams.length === 0) return new Set()

    const keys = upstreams.map((upstream) =>
      failedUpstreamKey(upstream, pathname),
    )
    const values = await runRedisCommandWithFreshClient(
      this.valkeyUrl,
      'mget failed upstreams',
      (client) => client.mGet(keys),
    )
    const failedUpstreams = new Set<string>()

    for (const [index, value] of values.entries()) {
      if (value) failedUpstreams.add(upstreams[index])
    }
    return failedUpstreams
  }

  // 将某个上游在当前路由上的失败标记写入 Redis / Aiven Valkey，并设置短 TTL。
  async markUpstreamFailed(
    upstream: string,
    pathname: string,
    ttlSeconds: number,
  ): Promise<void> {
    await runRedisCommandWithFreshClient(
      this.valkeyUrl,
      'set failed upstream marker',
      (client) =>
        client.set(failedUpstreamKey(upstream, pathname), '1', {
          expiration: {
            type: 'EX',
            value: ttlSeconds,
          },
        }),
    )
  }
}

class RedisHttpStateStore implements StateStore {
  constructor(private readonly env: StateStoreEnv) {}

  // 从 Redis HTTP proxy 读取上游实例列表，保持与直连 Redis 相同的 key。
  async getInstances(): Promise<string[] | undefined> {
    const client = getRedisHttpClient(getRedisHttpConfig(this.env))
    const raw = await runRedisHttpCommand('get instances', () =>
      client.get<string>(INSTANCES_KEY),
    )
    return parseInstances(raw)
  }

  // 将上游实例列表整体写入 Redis HTTP proxy，值格式继续使用 JSON 字符串。
  async setInstances(upstreams: string[]): Promise<void> {
    const client = getRedisHttpClient(getRedisHttpConfig(this.env))
    await runRedisHttpCommand('set instances', () =>
      client.set(INSTANCES_KEY, JSON.stringify(upstreams)),
    )
  }

  // 使用 MGET 通过 Redis HTTP proxy 一次性读取当前路由的失败标记。
  async getFailedUpstreams(
    upstreams: readonly string[],
    pathname: string,
  ): Promise<Set<string>> {
    if (upstreams.length === 0) return new Set()

    const client = getRedisHttpClient(getRedisHttpConfig(this.env))
    const keys = upstreams.map((upstream) =>
      failedUpstreamKey(upstream, pathname),
    )
    const values = await runRedisHttpCommand('mget failed upstreams', () =>
      client.mget<Array<string | null>>(keys),
    )
    const failedUpstreams = new Set<string>()

    for (const [index, value] of values.entries()) {
      if (value) failedUpstreams.add(upstreams[index])
    }
    return failedUpstreams
  }

  // 将某个上游在当前路由上的失败标记写入 Redis HTTP proxy，并设置短 TTL。
  async markUpstreamFailed(
    upstream: string,
    pathname: string,
    ttlSeconds: number,
  ): Promise<void> {
    const client = getRedisHttpClient(getRedisHttpConfig(this.env))
    await runRedisHttpCommand('set failed upstream marker', () =>
      client.set(failedUpstreamKey(upstream, pathname), '1', {
        ex: ttlSeconds,
      }),
    )
  }
}

// 根据环境变量创建统一状态存储，确保 instances 与 fail:* 始终落到同一个后端。
export function createStateStore(env: StateStoreEnv): StateStore {
  const backend = getStateStoreBackend(env.STATE_STORE_BACKEND)
  if (backend === 'redis') return new RedisStateStore(env.VALKEY_URL)
  if (backend === 'redis-http') return new RedisHttpStateStore(env)
  return new KvStateStore(env.KV)
}
