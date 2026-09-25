import { proxy } from 'hono/proxy'
import { config } from './config'
import { upstreamLogger, withRequestId } from './log'
import * as redis from './redis'
import { shuffle, trimSlash } from './utils'

// `forward` 表示当前尝试正好命中了缓存探测选出的上游；
// `fallback` 表示没有命中缓存，或命中的上游失败后进入兜底重试。
type UpstreamAttemptKind = 'forward' | 'fallback'

type UpstreamPhase = 'prepare' | 'cache_probe' | 'fetch'

type InstancesCache = {
  upstreams: string[]
  updatedAtMs: number
}

export type UpstreamFetchResult = {
  response: Response
  upstream?: string
}

// 按 hostname 排除本服务，协议、端口、大小写和域名末尾点不能绕过检查。
export function excludeSelfUpstreams(upstreams: readonly string[]): string[] {
  return upstreams.filter((upstream) => {
    try {
      const hostname = new URL(upstream).hostname.replace(/\.$/, '')
      return hostname !== 'rsshub-balancer.virworks.moe'
    } catch {
      // 无效 URL 无法作为 HTTP 上游，避免它绕过候选检查进入探测。
      return false
    }
  })
}

// 从 GitHub 获取远程实例列表；同一个超时信号覆盖连接、响应头和完整正文读取。
export async function fetchRemoteInstances(): Promise<string[]> {
  const res = await fetch(
    'https://raw.githubusercontent.com/RSSNext/rsshub-docs/main/.vitepress/theme/components/InstanceList.vue',
    { signal: AbortSignal.timeout(15000) },
  )
  if (!res.ok) {
    throw new Error(`fetch instances failed: ${res.status}`)
  }
  const text = await res.text()
  const matches = text.matchAll(/url:\s*['"]([^'"]+)['"]/g)
  const urls: string[] = []
  for (const m of matches) {
    urls.push(trimSlash(m[1]))
  }
  return excludeSelfUpstreams(urls)
}

// 模块内缓存由当前进程或 isolate 的 HTTP 与定时刷新共用，两端独立运行。
let instancesCache: InstancesCache | undefined
let instancesRefreshPromise: Promise<string[] | undefined> | undefined

// 更新当前运行时的 instances 内存缓存，用于请求热路径复用最近一次非空列表。
export function cacheInstances(upstreams: readonly string[]): string[] {
  const nowMs = Date.now()
  const cachedUpstreams = excludeSelfUpstreams(upstreams)
  // 存量快照也可能包含自身；过滤后为空时保留旧快照，无旧值则使用固定 fallback。
  if (cachedUpstreams.length === 0) {
    return [...(instancesCache?.upstreams ?? config.fallbackUpstreams)]
  }
  instancesCache = {
    upstreams: cachedUpstreams,
    updatedAtMs: nowMs,
  }

  return [...cachedUpstreams]
}

// 从 Redis 读取实例列表；为空时保留旧缓存，无缓存时仅使用 fallback，不写回 Redis。
async function readInstancesFromRedis(): Promise<string[]> {
  const list = await redis.getInstances()
  if (list && list.length > 0) return cacheInstances(list)

  upstreamLogger.warn('redis instances empty; keeping current instances', {
    event: 'redis.instances_cache',
    outcome: instancesCache ? 'empty_using_cache' : 'empty_using_fallback',
    upstreamCount:
      instancesCache?.upstreams.length ?? config.fallbackUpstreams.length,
  })

  return [...(instancesCache?.upstreams ?? config.fallbackUpstreams)]
}

// 同一进程或 isolate 的冷启动和过期读取共用一个刷新任务，失败时保留旧缓存。
function ensureInstancesRefresh(): Promise<string[] | undefined> {
  if (instancesRefreshPromise) return instancesRefreshPromise

  const startedAt = Date.now()
  instancesRefreshPromise = (async () => {
    try {
      return await readInstancesFromRedis()
    } catch (e) {
      upstreamLogger.warn(
        'redis instances read failed; keeping current instances',
        {
          event: 'redis.instances_cache',
          outcome: instancesCache
            ? 'refresh_failed_using_cache'
            : 'miss_failed_using_fallback',
          upstreamCount:
            instancesCache?.upstreams.length ?? config.fallbackUpstreams.length,
          cacheAgeMs: instancesCache
            ? Date.now() - instancesCache.updatedAtMs
            : undefined,
          refreshIntervalSeconds: config.instancesRefreshIntervalSeconds,
          refreshDurationMs: Date.now() - startedAt,
          error: e,
        },
      )
      return undefined
    } finally {
      instancesRefreshPromise = undefined
    }
  })()

  return instancesRefreshPromise
}

// 600 秒内复用内存缓存；过期请求等待同一次 Redis 读取，完全无缓存时才 fallback。
export async function getUpstreams(): Promise<string[]> {
  const nowMs = Date.now()
  if (instancesCache) {
    const cacheAgeMs = nowMs - instancesCache.updatedAtMs
    const refreshIntervalMs = config.instancesRefreshIntervalSeconds * 1000
    if (cacheAgeMs < refreshIntervalMs) return [...instancesCache.upstreams]
  }

  const refreshed = await ensureInstancesRefresh()
  return [
    ...(refreshed ?? instancesCache?.upstreams ?? config.fallbackUpstreams),
  ]
}

// 在请求内等待失败标记写入；写入异常只记录 warning，不能影响当前请求响应。
async function markFailedUpstream(
  upstream: string,
  pathname: string,
  ttlSeconds: number,
): Promise<void> {
  try {
    await redis.markUpstreamFailed(upstream, pathname, ttlSeconds)
  } catch (e) {
    upstreamLogger.warn('redis failed marker write failed; ignoring marker', {
      event: 'redis.fail_marker',
      outcome: 'ignored_write_failure',
      upstream,
      pathname,
      ttlSeconds,
      error: e,
    })
  }
}

// 按优先级依次尝试上游实例，返回首个成功响应和最终触达的上游；全部失败时返回 502。
export async function fetchFromUpstream(
  request: Request,
): Promise<UpstreamFetchResult> {
  const tracedRequest = withRequestId(request)
  const startedAt = Date.now()
  let phase: UpstreamPhase = 'prepare'
  let healthyUpstreamCount = 0
  let failedUpstreamCount = 0
  let probeCount = 0
  let cacheHit = false
  let attemptCount = 0
  let forwardAttemptCount = 0
  let fallbackAttemptCount = 0
  const attemptedUpstreams: string[] = []
  let finalAttemptKind: UpstreamAttemptKind | undefined
  let selectedUpstreamHost: string | undefined
  let finalUpstreamHost: string | undefined
  let prepareDurationMs: number | undefined
  let cacheProbeDurationMs: number | undefined
  let fetchDurationMs: number | undefined
  let cacheProbeStartedAt: number | undefined
  let fetchStartedAt: number | undefined
  try {
    const upstreams = await getUpstreams()
    const url = new URL(tracedRequest.url)
    const requestPath = url.pathname + url.search
    const pathname = url.pathname
    // 并行读取所有上游对当前路由的失败记录；失败时按全健康处理。
    let failedUpstreams: Set<string>
    try {
      failedUpstreams = await redis.getFailedUpstreams(upstreams, pathname)
    } catch {
      failedUpstreams = new Set()
    }

    // 失败标记在 TTL 内表示该路由近期已在对应上游失败，本次直接跳过这些候选。
    const healthyUpstreams = upstreams.filter((u) => !failedUpstreams.has(u))
    healthyUpstreamCount = healthyUpstreams.length
    failedUpstreamCount = failedUpstreams.size
    if (healthyUpstreamCount === 0) {
      prepareDurationMs = Date.now() - startedAt
      upstreamLogger.error('all upstreams marked failed; skipping fetch', {
        event: 'upstream.fetch',
        outcome: 'all_marked_failed',
        status: 502,
        durationMs: Date.now() - startedAt,
        prepareDurationMs,
        upstreamCount: upstreams.length,
        healthyUpstreamCount,
        failedUpstreamCount,
      })
      return {
        response: new Response('All upstreams failed to handle this request', {
          status: 502,
          headers: { 'content-type': 'text/plain; charset=UTF-8' },
        }),
        upstream: finalUpstreamHost,
      }
    }

    const orderedUpstreams = shuffle(healthyUpstreams)

    prepareDurationMs = Date.now() - startedAt
    probeCount = orderedUpstreams.length
    phase = 'cache_probe'
    cacheProbeStartedAt = Date.now()
    try {
      selectedUpstreamHost = await Promise.any(
        orderedUpstreams.map(async (upstream) => {
          const statusUrl = `${upstream}/api/route/status?requestPath=${encodeURIComponent(requestPath)}`
          const check = await fetch(statusUrl, {
            signal: AbortSignal.timeout(5000),
          })
          if (check.status === 200) return upstream
          throw new Error(`${check.status}`)
        }),
      )
    } catch {
      selectedUpstreamHost = undefined
    }
    cacheProbeDurationMs = Date.now() - cacheProbeStartedAt
    cacheHit = Boolean(selectedUpstreamHost)
    // 缓存探测阶段只记录“是否命中”以及命中的候选上游，不再按实例逐条展开。
    upstreamLogger.info('upstream cache probe completed', {
      event: 'upstream.cache_probe',
      outcome: cacheHit ? 'hit' : 'miss',
      cacheHit,
      selectedUpstreamHost,
      probeCount,
      durationMs: cacheProbeDurationMs,
      healthyUpstreamCount,
      failedUpstreamCount,
    })

    if (selectedUpstreamHost) {
      const idx = orderedUpstreams.indexOf(selectedUpstreamHost)
      if (idx > 0) {
        orderedUpstreams.splice(idx, 1)
        orderedUpstreams.unshift(selectedUpstreamHost)
      }
    }

    // 依次请求直到成功
    phase = 'fetch'
    fetchStartedAt = Date.now()
    for (const [index, upstream] of orderedUpstreams.entries()) {
      const attemptKind =
        selectedUpstreamHost && index === 0 && upstream === selectedUpstreamHost
          ? 'forward'
          : 'fallback'
      attemptCount += 1
      finalAttemptKind = attemptKind
      finalUpstreamHost = upstream
      attemptedUpstreams.push(upstream)
      if (attemptKind === 'forward') {
        forwardAttemptCount += 1
      } else {
        fallbackAttemptCount += 1
      }
      try {
        const res = await proxy(upstream + requestPath, {
          raw: tracedRequest,
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
        })
        if (res.status >= 200 && res.status < 400) {
          fetchDurationMs = Date.now() - fetchStartedAt
          upstreamLogger.info('upstream fetch completed', {
            event: 'upstream.fetch',
            outcome:
              finalAttemptKind === 'forward'
                ? 'forward_succeeded'
                : 'fallback_succeeded',
            status: res.status,
            durationMs: Date.now() - startedAt,
            ...(prepareDurationMs !== undefined ? { prepareDurationMs } : {}),
            ...(cacheProbeDurationMs !== undefined
              ? { cacheProbeDurationMs }
              : {}),
            ...(fetchDurationMs !== undefined ? { fetchDurationMs } : {}),
            attemptCount,
            retryCount: Math.max(attemptCount - 1, 0),
            forwardAttemptCount,
            fallbackAttemptCount,
            attemptedUpstreams,
            finalAttemptKind,
            cacheHit,
            selectedUpstreamHost,
            finalUpstreamHost,
            fallbackUsed: fallbackAttemptCount > 0,
          })
          return {
            response: res,
            upstream: finalUpstreamHost,
          }
        }
      } catch {}
      // 仅在当前路由尚未标记该上游失败时才写入，减少重复 Redis 写入。
      if (!failedUpstreams.has(upstream)) {
        failedUpstreams.add(upstream)
        await markFailedUpstream(upstream, pathname, config.failTtl)
      }
    }

    // 当前请求未被任何上游成功处理
    fetchDurationMs = Date.now() - fetchStartedAt
    upstreamLogger.error('upstream fetch failed', {
      event: 'upstream.fetch',
      outcome: 'all_failed',
      status: 502,
      durationMs: Date.now() - startedAt,
      ...(prepareDurationMs !== undefined ? { prepareDurationMs } : {}),
      ...(cacheProbeDurationMs !== undefined ? { cacheProbeDurationMs } : {}),
      ...(fetchDurationMs !== undefined ? { fetchDurationMs } : {}),
      attemptCount,
      retryCount: Math.max(attemptCount - 1, 0),
      forwardAttemptCount,
      fallbackAttemptCount,
      attemptedUpstreams,
      finalAttemptKind,
      cacheHit,
      selectedUpstreamHost,
      finalUpstreamHost,
      fallbackUsed: fallbackAttemptCount > 0,
    })
    return {
      response: new Response('All upstreams failed to handle this request', {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=UTF-8' },
      }),
      upstream: finalUpstreamHost,
    }
  } catch (e) {
    if (phase === 'prepare') {
      prepareDurationMs = Date.now() - startedAt
    } else if (phase === 'cache_probe' && cacheProbeStartedAt !== undefined) {
      cacheProbeDurationMs = Date.now() - cacheProbeStartedAt
    } else if (phase === 'fetch' && fetchStartedAt !== undefined) {
      fetchDurationMs = Date.now() - fetchStartedAt
    }
    upstreamLogger.error('upstream fetch raised an unexpected error', {
      event: 'upstream.fetch',
      outcome: 'error',
      phase,
      status: 502,
      durationMs: Date.now() - startedAt,
      ...(prepareDurationMs !== undefined ? { prepareDurationMs } : {}),
      ...(cacheProbeDurationMs !== undefined ? { cacheProbeDurationMs } : {}),
      ...(fetchDurationMs !== undefined ? { fetchDurationMs } : {}),
      healthyUpstreamCount,
      failedUpstreamCount,
      probeCount,
      cacheHit,
      attemptCount,
      retryCount: Math.max(attemptCount - 1, 0),
      forwardAttemptCount,
      fallbackAttemptCount,
      attemptedUpstreams,
      finalAttemptKind,
      selectedUpstreamHost,
      finalUpstreamHost,
      fallbackUsed: fallbackAttemptCount > 0,
      error: e,
    })
    return {
      response: new Response('Internal error', {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=UTF-8' },
      }),
      upstream: finalUpstreamHost,
    }
  }
}
