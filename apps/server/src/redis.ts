import { runRedisCommand as runNodeRedisCommand } from './adapters/redis-node'
import { runRedisCommand as runWorkerRedisCommand } from './adapters/redis-worker'

type RedisRuntime = 'node' | 'worker'

let runtime: RedisRuntime | undefined

// 两个入口各设置一次运行环境及对应的 key 前缀，连接仍在执行命令时按需建立。
export function configureRedis(value: RedisRuntime): void {
  if (runtime && runtime !== value) {
    throw new Error('Redis runtime is already initialized')
  }
  runtime = value
}

// 未初始化时直接报错，避免把 Node 请求误写入 Worker 命名空间。
function getRuntime(): RedisRuntime {
  if (!runtime) throw new Error('Redis runtime is not initialized')
  return runtime
}

// 解析 Redis 原始 JSON 字符串，无效或空列表由调用方使用既有降级逻辑。
function parseInstances(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  try {
    const list = JSON.parse(raw) as string[]
    if (Array.isArray(list) && list.length > 0) return list
  } catch {}
  return undefined
}

// 动态段继续编码，运行时前缀由入口固定设置，禁止回退到另一端或旧的无前缀 key。
function failedUpstreamKey(
  runtime: RedisRuntime,
  upstream: string,
  pathname: string,
): string {
  return `${runtime}:fail:${encodeURIComponent(pathname)}:${encodeURIComponent(upstream)}`
}

// 按入口选择的运行环境执行命令，Worker 每次关闭连接，Node 复用模块内连接。
const runCommand: typeof runWorkerRedisCommand = async (operation, command) => {
  const run =
    getRuntime() === 'node' ? runNodeRedisCommand : runWorkerRedisCommand
  return await run(operation, command)
}

// 从 Redis / Aiven Valkey 读取当前命名空间的上游实例列表。
export async function getInstances(): Promise<string[] | undefined> {
  const key = `${getRuntime()}:instances`
  const raw = await runCommand('get instances', (client) => client.get(key))
  return parseInstances(raw)
}

// 将上游实例列表整体写入 Redis / Aiven Valkey。
export async function setInstances(upstreams: string[]): Promise<void> {
  const key = `${getRuntime()}:instances`
  await runCommand('set instances', (client) =>
    client.set(key, JSON.stringify(upstreams)),
  )
}

// 使用 MGET 一次性读取当前路由在 Redis / Aiven Valkey 中的失败标记。
export async function getFailedUpstreams(
  upstreams: readonly string[],
  pathname: string,
): Promise<Set<string>> {
  if (upstreams.length === 0) return new Set()

  const runtime = getRuntime()
  const keys = upstreams.map((upstream) =>
    failedUpstreamKey(runtime, upstream, pathname),
  )
  const values = await runCommand('mget failed upstreams', (client) =>
    client.mGet(keys),
  )
  const failedUpstreams = new Set<string>()

  for (const [index, value] of values.entries()) {
    if (value) failedUpstreams.add(upstreams[index])
  }
  return failedUpstreams
}

// 将某个上游在当前路由上的失败标记写入 Redis / Aiven Valkey，并设置短 TTL。
export async function markUpstreamFailed(
  upstream: string,
  pathname: string,
  ttlSeconds: number,
): Promise<void> {
  const key = failedUpstreamKey(getRuntime(), upstream, pathname)
  await runCommand('set failed upstream marker', (client) =>
    client.set(key, '1', {
      expiration: {
        type: 'EX',
        value: ttlSeconds,
      },
    }),
  )
}
