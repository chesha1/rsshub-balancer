// 只描述共享存储规则用到的 Redis 命令，不依赖具体 SDK 或平台连接实现。
export type RedisCommands = {
  get(key: string): Promise<string | null>
  mGet(keys: string[]): Promise<(string | null)[]>
  set(
    key: string,
    value: string,
    options?: { expiration: { type: 'EX'; value: number } },
  ): Promise<unknown>
}

export type RedisCommandRunner = <T>(
  operation: string,
  command: (client: RedisCommands) => Promise<T>,
) => Promise<T>

type RedisConfiguration = {
  namespace: 'node' | 'worker'
  runCommand: RedisCommandRunner
}

let configuration: RedisConfiguration | undefined

// 启动时固定命名空间与执行器；重复配置仅接受同一实现，避免运行中混用两端状态。
export function configureRedis(
  namespace: RedisConfiguration['namespace'],
  runCommand: RedisCommandRunner,
): void {
  if (configuration) {
    if (
      configuration.namespace !== namespace ||
      configuration.runCommand !== runCommand
    ) {
      throw new Error('Redis is already configured')
    }
    return
  }
  configuration = { namespace, runCommand }
}

// 业务首次访问前必须由应用完成配置，导入模块本身不会连接 Redis。
function getConfiguration(): RedisConfiguration {
  if (!configuration) throw new Error('Redis is not configured')
  return configuration
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

// 动态段编码避免路径与上游地址中的分隔符改变 key 结构。
function failedUpstreamKey(
  namespace: string,
  upstream: string,
  pathname: string,
): string {
  return `${namespace}:fail:${encodeURIComponent(pathname)}:${encodeURIComponent(upstream)}`
}

// 从当前命名空间读取上游列表，不回退到另一端或历史 key。
export async function getInstances(): Promise<string[] | undefined> {
  const { namespace, runCommand } = getConfiguration()
  const raw = await runCommand('get instances', (client) =>
    client.get(`${namespace}:instances`),
  )
  return parseInstances(raw)
}

// 整体替换上游快照，与两端的定时刷新保持相同语义。
export async function setInstances(upstreams: string[]): Promise<void> {
  const { namespace, runCommand } = getConfiguration()
  await runCommand('set instances', (client) =>
    client.set(`${namespace}:instances`, JSON.stringify(upstreams)),
  )
}

// 使用一次 MGET 读取同一路由下的全部失败标记。
export async function getFailedUpstreams(
  upstreams: readonly string[],
  pathname: string,
): Promise<Set<string>> {
  if (upstreams.length === 0) return new Set()
  const { namespace, runCommand } = getConfiguration()
  const keys = upstreams.map((upstream) =>
    failedUpstreamKey(namespace, upstream, pathname),
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

// 失败标记使用既有 TTL，连接或命令失败由上层统一降级。
export async function markUpstreamFailed(
  upstream: string,
  pathname: string,
  ttlSeconds: number,
): Promise<void> {
  const { namespace, runCommand } = getConfiguration()
  await runCommand('set failed upstream marker', (client) =>
    client.set(failedUpstreamKey(namespace, upstream, pathname), '1', {
      expiration: { type: 'EX', value: ttlSeconds },
    }),
  )
}
