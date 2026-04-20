import { config } from './config'
import {
  bindRequestLogger,
  errorProps,
  upstreamLogger,
  withRequestId,
  withResponseRequestId,
} from './log'
import { shuffle, trimSlash } from './utils'

// `forward` 表示当前尝试正好命中了缓存探测选出的上游；
// `fallback` 表示没有命中缓存，或命中的上游失败后进入兜底重试。
type UpstreamAttemptKind = 'forward' | 'fallback'

type UpstreamPhase = 'prepare' | 'cache_probe' | 'fetch'

type UpstreamLogContext = {
  degradedToDirect?: boolean
  degradeReason?: string
  degradeError?: Record<string, unknown>
}

// 从 GitHub 获取远程实例列表
export async function fetchRemoteInstances(): Promise<string[]> {
  const res = await fetch(
    'https://raw.githubusercontent.com/RSSNext/rsshub-docs/main/.vitepress/theme/components/InstanceList.vue',
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
  return urls
}

// 从 KV 读取实例列表；首次为空时写入 fallbackUpstreams 作为种子
export async function getUpstreams(kv: KVNamespace): Promise<string[]> {
  const raw = await kv.get('instances')
  if (raw) {
    try {
      const list = JSON.parse(raw) as string[]
      if (list.length > 0) return list
    } catch {
      // JSON 解析失败，回退
    }
  }
  await kv.put('instances', JSON.stringify(config.fallbackUpstreams))
  return config.fallbackUpstreams
}

// 按优先级依次尝试上游实例，返回首个成功响应；全部失败时返回 502
export async function fetchFromUpstream(
  request: Request,
  kv: KVNamespace,
  waitUntil: (p: Promise<unknown>) => void,
  requestId: string,
  logContext: UpstreamLogContext = {},
): Promise<Response> {
  const tracedRequest = withRequestId(request, requestId)
  const logger = bindRequestLogger(upstreamLogger, requestId, tracedRequest)
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
    const upstreams = await getUpstreams(kv)
    const url = new URL(tracedRequest.url)
    const requestPath = url.pathname + url.search
    const pathname = url.pathname
    const method = tracedRequest.method
    const headers = tracedRequest.headers
    // 非幂等请求需要缓冲 body 以支持顺序重试
    const body =
      method !== 'GET' && method !== 'HEAD'
        ? await tracedRequest.arrayBuffer()
        : undefined
    // 并行读取所有上游对当前路由的失败记录
    const failKeys = upstreams.map((u) => `fail:${u}|${pathname}`)
    const failResults = await Promise.all(failKeys.map((key) => kv.get(key)))
    const failedUpstreams = upstreams.filter((_, i) => failResults[i])

    // 分为 healthy / unhealthy 两组，各组内随机洗牌
    const healthyUpstreams = upstreams.filter(
      (u) => !failedUpstreams.includes(u),
    )
    healthyUpstreamCount = healthyUpstreams.length
    failedUpstreamCount = failedUpstreams.length
    const orderedUpstreams = [
      ...shuffle(healthyUpstreams),
      ...shuffle(failedUpstreams),
    ]

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
    logger.info('upstream cache probe completed', {
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
        const res = await fetch(upstream + requestPath, {
          method,
          redirect: 'manual',
          headers,
          body,
          signal: AbortSignal.timeout(15000),
        })
        if (res.status >= 200 && res.status < 400) {
          fetchDurationMs = Date.now() - fetchStartedAt
          logger.info('upstream fetch completed', {
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
            ...logContext,
          })
          return withResponseRequestId(res, requestId)
        }
      } catch {}
      // 仅在当前路由尚未标记该上游失败时才写入，减少重复 KV 写入。
      if (!failedUpstreams.includes(upstream)) {
        failedUpstreams.push(upstream)
        const failKey = `fail:${upstream}|${pathname}`
        waitUntil(kv.put(failKey, '1', { expirationTtl: config.failTtl }))
      }
    }

    // 当前请求未被任何上游成功处理
    fetchDurationMs = Date.now() - fetchStartedAt
    logger.error('upstream fetch failed', {
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
      ...logContext,
    })
    return withResponseRequestId(
      new Response('All upstreams failed to handle this request', {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=UTF-8' },
      }),
      requestId,
    )
  } catch (e) {
    if (phase === 'prepare') {
      prepareDurationMs = Date.now() - startedAt
    } else if (phase === 'cache_probe' && cacheProbeStartedAt !== undefined) {
      cacheProbeDurationMs = Date.now() - cacheProbeStartedAt
    } else if (phase === 'fetch' && fetchStartedAt !== undefined) {
      fetchDurationMs = Date.now() - fetchStartedAt
    }
    logger.error('upstream fetch raised an unexpected error', {
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
      ...logContext,
      fallbackUsed: fallbackAttemptCount > 0,
      ...errorProps(e),
    })
    return withResponseRequestId(
      new Response('Internal error', {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=UTF-8' },
      }),
      requestId,
    )
  }
}
