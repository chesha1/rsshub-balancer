import { config } from './config'
import { cronLogger, errorProps } from './log'
import { createStateStore } from './store'
import { cacheInstances, fetchRemoteInstances } from './upstream'
import { trimSlash } from './utils'

// 定时刷新远程 RSSHub 实例列表，健康检查通过后写入状态存储和本地缓存。
export async function scheduled(
  _event: ScheduledEvent,
  env: CloudflareBindings,
  _ctx: ExecutionContext,
) {
  const startedAt = Date.now()
  let previous: string[] = []
  const stateStore = createStateStore(env)
  try {
    try {
      previous = (await stateStore.getInstances()) ?? []
    } catch {}
    const remote = await fetchRemoteInstances()
    // 与 fallback 合并去重
    const merged = [
      ...new Set([...remote.map(trimSlash), ...config.fallbackUpstreams]),
    ]
    // 并行健康检查，只保留可用实例
    const checks = await Promise.all(
      merged.map(async (u) => {
        try {
          const res = await fetch(`${u}/healthz`, {
            signal: AbortSignal.timeout(5000),
            redirect: 'manual',
          })
          return res.ok
        } catch {
          return false
        }
      }),
    )
    const healthy = merged.filter((_, i) => checks[i])
    const previousSet = new Set(previous)
    const healthySet = new Set(healthy)
    const addedHosts = healthy.filter((u) => !previousSet.has(u))
    const removedHosts = previous.filter((u) => !healthySet.has(u))
    if (healthy.length === 0) {
      cronLogger.warn('scheduled refresh found no healthy upstreams', {
        event: 'cron.refresh',
        outcome: 'retain_existing',
        remoteCount: remote.length,
        mergedCount: merged.length,
        healthyCount: 0,
        previousCount: previous.length,
        durationMs: Date.now() - startedAt,
      })
      return
    }
    await stateStore.setInstances(healthy)
    cacheInstances(healthy)
    cronLogger.info('scheduled refresh updated upstream instances', {
      event: 'cron.refresh',
      outcome: 'updated',
      remoteCount: remote.length,
      mergedCount: merged.length,
      healthyCount: healthy.length,
      previousCount: previous.length,
      addedHosts,
      removedHosts,
      durationMs: Date.now() - startedAt,
    })
  } catch (e) {
    cronLogger.warn('scheduled refresh failed; keeping existing instances', {
      event: 'cron.refresh',
      outcome: 'retain_existing',
      previousCount: previous.length,
      durationMs: Date.now() - startedAt,
      ...errorProps(e),
    })
  }
}
