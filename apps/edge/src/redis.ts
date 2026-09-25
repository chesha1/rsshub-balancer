import type { RedisClientType } from '@redis/client'
import { redisLogger } from '@rsshub-balancer/server-core/log'

const REDIS_TIMEOUT_MS = 2000

// 在提交前开始计时，覆盖完整建连或命令；超时不重试，迟到结果由 race 消费。
async function withTimeout<T>(
  operation: string,
  task: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(`redis ${operation} timed out after ${REDIS_TIMEOUT_MS}ms`),
        )
      }, REDIS_TIMEOUT_MS)
    })
    return await Promise.race([task(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

// Worker 每次只处理一条命令，按连接、执行、关闭顺序完成，不共享 socket 或 Node 状态机。
export async function runRedisCommand<T>(
  operation: string,
  command: (client: RedisClientType) => Promise<T>,
): Promise<T> {
  const url = process.env.VALKEY_URL?.trim()
  if (!url) throw new Error('VALKEY_URL is required')
  // ingest 不访问 Redis；首次执行命令时才加载 SDK，模块由运行时缓存，连接仍逐次创建。
  const { createClient } = await import('@redis/client')
  const client = createClient({
    url,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 32,
    socket: { connectTimeout: REDIS_TIMEOUT_MS, reconnectStrategy: false },
  })
  // SDK 要求监听 error；连接和命令拒绝统一由下方 catch 记录，避免同一故障重复输出。
  client.on('error', () => {})
  try {
    await withTimeout('connect', () => client.connect())
    return await withTimeout(operation, () => command(client))
  } catch (error) {
    redisLogger.warn('redis operation failed', {
      event: 'redis.command',
      operation,
      error,
    })
    throw error
  } finally {
    if (client.isOpen) client.destroy()
  }
}
