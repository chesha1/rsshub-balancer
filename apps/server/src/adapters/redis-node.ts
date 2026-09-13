import { createClient, type RedisClientType } from '@redis/client'
import { errorProps, redisLogger } from '../log'

const REDIS_TIMEOUT_MS = 2000

type InFlightCommand = {
  deadlineMs: number
  reject(error: Error): void
}

type ConnectionPhase = 'connecting' | 'ready' | 'draining' | 'closed'

class RedisTimeoutError extends Error {
  // 明确区分连接或命令超时，业务只将其当作可降级的状态存储失败。
  constructor(operation: string, timeoutMs: number) {
    super(`redis ${operation} timed out after ${timeoutMs}ms`)
    this.name = 'RedisTimeoutError'
  }
}

class RedisUnavailableError extends Error {
  // 正在收尾或已关闭的连接拒绝新操作，避免排队或重发结果不明的写入。
  constructor(reason: string) {
    super(`redis client unavailable: ${reason}`)
    this.name = 'RedisUnavailableError'
  }
}

class NodeRedisConnection {
  private phase: ConnectionPhase = 'connecting'
  private connecting: Promise<void> | undefined
  private rejectConnect: ((error: Error) => void) | undefined
  private readonly inFlight = new Set<InFlightCommand>()
  private drainTimer: ReturnType<typeof setTimeout> | undefined
  private drainDeadlineMs = Number.POSITIVE_INFINITY

  // 每个连接独立保存回调与在途命令，旧连接的迟到事件只能清理自身。
  constructor(
    private readonly client: RedisClientType,
    private readonly onClosed: () => void,
  ) {
    client.on('error', (error) => {
      redisLogger.warn('redis client emitted an error', {
        event: 'redis.client',
        outcome: 'error',
        ...errorProps(error),
      })
      // 命令错误不等于断线；SDK 已确认不再 ready 时才影响其他在途命令。
      if (this.phase !== 'connecting' && !client.isReady) {
        this.destroy('disconnected')
      }
    })
    client.on('end', () => this.destroy('disconnected'))
  }

  // 首次建连共用同一个 Promise，失败交给后续调用重建，不在当前操作中重试。
  async ready(): Promise<void> {
    if (this.phase === 'closed' || this.phase === 'draining') {
      throw new RedisUnavailableError(this.phase)
    }
    if (this.phase === 'ready') {
      if (this.client.isReady) return
      this.destroy('disconnected')
      throw new RedisUnavailableError('disconnected')
    }
    this.connecting ??= this.connect()
    await this.connecting
  }

  // 将 DNS、socket、认证和协议初始化一起限制在两秒内，并消费迟到的建连结果。
  private async connect(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        this.rejectConnect = reject
        timer = setTimeout(() => {
          reject(new RedisTimeoutError('connect', REDIS_TIMEOUT_MS))
          this.destroy('connect_timeout')
        }, REDIS_TIMEOUT_MS)
        void this.observeConnect(resolve, reject)
      })
    } catch (error) {
      this.destroy('connect_failed')
      redisLogger.warn('redis connect failed', {
        event: 'redis.connect',
        outcome: error instanceof RedisTimeoutError ? 'timed_out' : 'failed',
        ...errorProps(error),
      })
      throw error
    } finally {
      clearTimeout(timer)
      this.rejectConnect = undefined
    }
  }

  // 连接关闭后建连即使迟到成功，也只销毁旧 socket，绝不重新投入使用。
  private async observeConnect(
    resolve: () => void,
    reject: (error: unknown) => void,
  ): Promise<void> {
    try {
      await this.client.connect()
      if (this.phase === 'closed') {
        this.destroySocket()
        return
      }
      this.phase = 'ready'
      resolve()
    } catch (error) {
      reject(error)
    }
  }

  // 从提交前开始计时，覆盖 SDK 排队、发送及回复；超时不解释为底层命令已取消。
  async run<T>(
    operation: string,
    command: (client: RedisClientType) => Promise<T>,
  ): Promise<T> {
    // ready() 与真正提交之间若发生断线，也立即淘汰连接且不发送业务命令。
    if (this.phase === 'ready' && !this.client.isReady) {
      this.destroy('disconnected')
    }
    if (this.phase !== 'ready' || !this.client.isReady) {
      throw new RedisUnavailableError(this.phase)
    }
    const startedAtMs = Date.now()
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        const error = new RedisTimeoutError(operation, REDIS_TIMEOUT_MS)
        pending.reject(error)
        redisLogger.warn('redis command timed out; draining client', {
          event: 'redis.command',
          outcome: 'timed_out',
          operation,
          durationMs: Date.now() - startedAtMs,
          ...errorProps(error),
        })
        // 在途集合仍保留底层命令，直到它真正结束或最晚原始截止时间到期。
        this.drain()
      }, REDIS_TIMEOUT_MS)
      const pending: InFlightCommand = {
        deadlineMs: startedAtMs + REDIS_TIMEOUT_MS,
        // 只完成调用方一次；底层结果迟到时仍由 observeCommand 消费。
        reject(error) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      }
      this.inFlight.add(pending)
      // 回调包装保证迟到成功只被消费，不再向业务层传递结果。
      void this.observeCommand(operation, command, pending, (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      })
    })
  }

  // 始终等待并消费 SDK 最终结果，普通命令错误保留连接，确认断线才立即销毁。
  private async observeCommand<T>(
    operation: string,
    command: (client: RedisClientType) => Promise<T>,
    pending: InFlightCommand,
    resolve: (result: T) => void,
  ): Promise<void> {
    try {
      resolve(await command(this.client))
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
      redisLogger.warn('redis command failed', {
        event: 'redis.command',
        outcome: 'failed',
        operation,
        ...errorProps(error),
      })
      if (!this.client.isReady) this.destroy('disconnected')
    } finally {
      this.inFlight.delete(pending)
      if (this.phase === 'draining' && this.inFlight.size === 0) {
        this.destroy('drained')
      }
    }
  }

  // 固定现有命令的最晚截止时间，重复超时不能延长连接收尾。
  drain(): void {
    if (this.phase === 'closed') return
    if (this.phase === 'connecting' || this.inFlight.size === 0) {
      this.destroy('drained')
      return
    }
    this.phase = 'draining'
    const lastCommandDeadline = Math.max(
      ...Array.from(this.inFlight, (command) => command.deadlineMs),
    )
    this.drainDeadlineMs = Math.min(this.drainDeadlineMs, lastCommandDeadline)
    clearTimeout(this.drainTimer)
    const remainingMs = this.drainDeadlineMs - Date.now()
    if (remainingMs <= 0) {
      this.destroy('drain_deadline')
      return
    }
    this.drainTimer = setTimeout(
      () => this.destroy('drain_deadline'),
      remainingMs,
    )
  }

  // 先更新生命周期再销毁 socket，防止同步 end/error 事件递归清理或污染新连接。
  destroy(reason: string): void {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    clearTimeout(this.drainTimer)
    const error = new RedisUnavailableError(reason)
    this.rejectConnect?.(error)
    for (const command of this.inFlight) command.reject(error)
    this.destroySocket()
    this.onClosed()
  }

  // SDK 的已关闭 client 不能再次 destroy，检查 isOpen 也覆盖迟到建连的清理。
  private destroySocket(): void {
    if (!this.client.isOpen) return
    try {
      this.client.destroy()
    } catch (error) {
      redisLogger.warn('redis client destroy failed', {
        event: 'redis.client',
        outcome: 'destroy_failed',
        ...errorProps(error),
      })
    }
  }
}

let current: NodeRedisConnection | undefined

// HTTP 和定时刷新复用进程内连接，首次并发共用建连，失败后的下一次操作按需重建。
export async function runRedisCommand<T>(
  operation: string,
  command: (client: RedisClientType) => Promise<T>,
): Promise<T> {
  if (!current) {
    const connection = new NodeRedisConnection(
      createClient({
        url: process.env.VALKEY_URL?.trim(),
        // Node 共享连接只受命令时限约束，不设置进程总并发上限，也不自动重连或离线排队。
        disableOfflineQueue: true,
        socket: { connectTimeout: REDIS_TIMEOUT_MS, reconnectStrategy: false },
      }),
      () => {
        if (current === connection) current = undefined
      },
    )
    current = connection
  }
  const connection = current
  await connection.ready()
  return await connection.run(operation, command)
}
