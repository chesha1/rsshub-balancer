import { config } from './config'
import { checkUpstreamHealth } from './health'
import { cronLogger } from './log'
import * as redis from './redis'
import * as upstream from './upstream'
import {
  getUpstreamDiagnosticRuntime,
  safeDiagnosticUrl,
} from './upstream-observability'
import { trimSlash } from './utils'

// 定时刷新远程 RSSHub 实例列表，健康检查通过后写入 Redis 和本地缓存。
export async function scheduled(): Promise<void> {
  const startedAt = Date.now()
  const requestId = crypto.randomUUID()
  const trace = { logged: false }
  let previous: string[] = []
  try {
    try {
      previous = (await redis.getInstances()) ?? []
    } catch {}
    const remote = await upstream.fetchRemoteInstances()
    // 与额外上游合并去重后先过滤被排除的实例，避免探测自身或已停用的上游。
    const merged = upstream.filterUpstreams([
      ...new Set([...remote.map(trimSlash), ...config.extraUpstreams]),
    ])
    // 并行健康检查，只保留可用实例
    const checks = await Promise.all(
      merged.map((u) =>
        checkUpstreamHealth(`${u}/healthz`, {
          signal: AbortSignal.timeout(5000),
          redirect: 'manual',
          action: 'exclude_from_refresh',
          trace,
          requestId,
        }),
      ),
    )
    const healthy = merged.filter((_, i) => checks[i])
    const previousSet = new Set(previous)
    const healthySet = new Set(healthy)
    const addedHosts = healthy.filter((u) => !previousSet.has(u))
    const removedHosts = previous.filter((u) => !healthySet.has(u))
    if (healthy.length === 0) {
      cronLogger.warn('scheduled refresh found no healthy upstreams', {
        event: 'cron.refresh',
        runtime: getUpstreamDiagnosticRuntime(),
        requestId,
        outcome: 'retain_existing',
        remoteCount: remote.length,
        mergedCount: merged.length,
        healthyCount: 0,
        previousCount: previous.length,
        durationMs: Date.now() - startedAt,
      })
      return
    }
    await redis.setInstances(healthy)
    upstream.cacheInstances(healthy)
    // 有异常样本时保留同一关联 ID 的刷新结果，便于确认实例最终是否被移除。
    const summary = {
      event: 'cron.refresh',
      runtime: getUpstreamDiagnosticRuntime(),
      requestId,
      outcome: 'updated',
      remoteCount: remote.length,
      mergedCount: merged.length,
      healthyCount: healthy.length,
      previousCount: previous.length,
      addedHosts: addedHosts.map(safeDiagnosticUrl),
      removedHosts: removedHosts.map(safeDiagnosticUrl),
      diagnosticsLogged: trace.logged,
      durationMs: Date.now() - startedAt,
    }
    if (trace.logged) {
      try {
        cronLogger.warn(
          'scheduled refresh completed with upstream diagnostics',
          summary,
        )
      } catch {
        // 上游列表已经刷新成功，诊断输出失败不应被记成刷新失败。
      }
    } else {
      cronLogger.info('scheduled refresh updated upstream instances', summary)
    }
  } catch (e) {
    cronLogger.warn('scheduled refresh failed; keeping existing instances', {
      event: 'cron.refresh',
      runtime: getUpstreamDiagnosticRuntime(),
      requestId,
      outcome: 'retain_existing',
      previousCount: previous.length,
      durationMs: Date.now() - startedAt,
      error: e,
    })
  }
}
