import { createClient } from '@redis/client'
import { errorProps, storeLogger } from './log'

const INSTANCES_KEY = 'instances'
const REDIS_COMMAND_TIMEOUT_MS = 2000

type StateStoreBackend = 'kv' | 'redis'

type StateStoreEnv = {
  KV: KVNamespace
  STATE_STORE_BACKEND?: string
  VALKEY_URL?: string
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

let redisClient: RedisClient | undefined
let redisClientUrl: string | undefined
let redisConnectPromise: Promise<RedisClient> | undefined

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

// 解析实例列表 JSON，保持与原 KV 版本一致的轻量非空判断。
function parseInstances(raw: string | null): string[] | undefined {
  if (!raw) return undefined

  try {
    const list = JSON.parse(raw) as string[]
    if (list.length > 0) return list
  } catch {}

  return undefined
}

// 统一生成失败标记 key，保证 KV 和 Redis 后端使用完全相同的业务 key。
function failedUpstreamKey(upstream: string, pathname: string): string {
  return `fail:${upstream}|${pathname}`
}

// 规范化状态存储后端配置；未知值回退到 KV，并写日志提示配置问题。
function getStateStoreBackend(
  rawBackend: string | undefined,
): StateStoreBackend {
  if (rawBackend === 'redis' || rawBackend === 'kv') return rawBackend
  if (rawBackend === undefined || rawBackend === '') return 'kv'

  storeLogger.warn('unknown state store backend; falling back to kv', {
    event: 'state_store.backend',
    outcome: 'fallback_kv',
    configuredBackend: rawBackend,
  })
  return 'kv'
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
      event: 'state_store.redis',
      outcome: 'client_error',
      ...errorProps(error),
    })
  })

  return client
}

// Redis 命令超时后销毁当前连接，避免后续请求继续复用已卡住的 client。
function destroyRedisClient(client: RedisClient): void {
  try {
    client.destroy()
  } catch (error) {
    storeLogger.warn('redis client destroy failed after command timeout', {
      event: 'state_store.redis',
      outcome: 'destroy_failed',
      ...errorProps(error),
    })
  }

  if (redisClient === client) {
    redisClient = undefined
    redisClientUrl = undefined
    redisConnectPromise = undefined
  }
}

// 给单次 Redis 命令加短超时，把挂起命令转换为可降级的异常。
async function runRedisCommandWithTimeout<T>(
  client: RedisClient,
  operation: string,
  runCommand: () => Promise<T>,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      destroyRedisClient(client)
      const error = new RedisCommandTimeoutError(
        operation,
        REDIS_COMMAND_TIMEOUT_MS,
      )
      storeLogger.warn('redis command timed out; falling back', {
        event: 'state_store.redis',
        outcome: 'command_timeout',
        operation,
        timeoutMs: REDIS_COMMAND_TIMEOUT_MS,
        ...errorProps(error),
      })
      reject(error)
    }, REDIS_COMMAND_TIMEOUT_MS)
  })

  try {
    return await Promise.race([runCommand(), timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

// 复用同一个 Redis 连接；连接失败时清掉缓存，下一次请求再重新尝试连接。
async function getRedisClient(
  valkeyUrl: string | undefined,
): Promise<RedisClient> {
  if (!valkeyUrl) {
    throw new Error('VALKEY_URL is required when STATE_STORE_BACKEND=redis')
  }

  if (redisClient && redisClientUrl === valkeyUrl && redisClient.isReady) {
    return redisClient
  }

  if (redisConnectPromise && redisClientUrl === valkeyUrl) {
    return await redisConnectPromise
  }

  if (redisClient) {
    redisClient.destroy()
    redisClient = undefined
    redisClientUrl = undefined
  }

  const client = createRedisClient(valkeyUrl)
  redisClient = client
  redisClientUrl = valkeyUrl
  redisConnectPromise = (async () => {
    try {
      await client.connect()
      return client
    } catch (error) {
      if (redisClient === client) {
        redisClient = undefined
        redisClientUrl = undefined
      }
      throw error
    } finally {
      redisConnectPromise = undefined
    }
  })()

  return await redisConnectPromise
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
    const client = await getRedisClient(this.valkeyUrl)
    const raw = await runRedisCommandWithTimeout(client, 'get instances', () =>
      client.get(INSTANCES_KEY),
    )
    return parseInstances(raw)
  }

  // 将上游实例列表整体写入 Redis / Aiven Valkey。
  async setInstances(upstreams: string[]): Promise<void> {
    const client = await getRedisClient(this.valkeyUrl)
    await runRedisCommandWithTimeout(client, 'set instances', () =>
      client.set(INSTANCES_KEY, JSON.stringify(upstreams)),
    )
  }

  // 使用 MGET 一次性读取当前路由在 Redis / Aiven Valkey 中的失败标记。
  async getFailedUpstreams(
    upstreams: readonly string[],
    pathname: string,
  ): Promise<Set<string>> {
    if (upstreams.length === 0) return new Set()

    const client = await getRedisClient(this.valkeyUrl)
    const keys = upstreams.map((upstream) =>
      failedUpstreamKey(upstream, pathname),
    )
    const values = await runRedisCommandWithTimeout(
      client,
      'mget failed upstreams',
      () => client.mGet(keys),
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
    const client = await getRedisClient(this.valkeyUrl)
    await runRedisCommandWithTimeout(client, 'set failed upstream marker', () =>
      client.set(failedUpstreamKey(upstream, pathname), '1', {
        expiration: {
          type: 'EX',
          value: ttlSeconds,
        },
      }),
    )
  }
}

// 根据环境变量创建统一状态存储，确保 instances 与 fail:* 始终落到同一个后端。
export function createStateStore(env: StateStoreEnv): StateStore {
  const backend = getStateStoreBackend(env.STATE_STORE_BACKEND)
  if (backend === 'redis') return new RedisStateStore(env.VALKEY_URL)
  return new KvStateStore(env.KV)
}
