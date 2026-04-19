import { config } from './config'
import {
  bindRequestLogger,
  errorProps,
  upstreamHost,
  upstreamLogger,
  withRequestId,
} from './log'
import { shuffle, trimSlash } from './utils'

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
): Promise<Response> {
  const tracedRequest = withRequestId(request, requestId)
  const logger = bindRequestLogger(upstreamLogger, requestId, tracedRequest)
  const startedAt = Date.now()
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
    const orderedUpstreams = [
      ...shuffle(healthyUpstreams),
      ...shuffle(failedUpstreams),
    ]

    // 并行检查所有上游实例的缓存状态
    let selected: string | undefined
    try {
      selected = await Promise.any(
        orderedUpstreams.map(async (upstream) => {
          const statusUrl = `${upstream}/api/route/status?requestPath=${encodeURIComponent(requestPath)}`
          try {
            const check = await fetch(statusUrl, {
              signal: AbortSignal.timeout(5000),
            })
            logger.debug('upstream cache probe finished', {
              event: 'upstream.cache_probe',
              upstreamHost: upstreamHost(upstream),
              status: check.status,
              cached: check.status === 200,
            })
            if (check.status === 200) return upstream
            throw new Error(`${check.status}`)
          } catch (e) {
            logger.debug('upstream cache probe errored', {
              event: 'upstream.cache_probe',
              upstreamHost: upstreamHost(upstream),
              cached: false,
              ...errorProps(e),
            })
            throw e
          }
        }),
      )
    } catch {
      selected = undefined
    }

    logger.info('upstream selection computed', {
      event: 'upstream.selection',
      healthyUpstreamCount: healthyUpstreams.length,
      failedUpstreamCount: failedUpstreams.length,
      orderedUpstreamHosts: orderedUpstreams.map(upstreamHost),
      cacheHit: Boolean(selected),
      selectedUpstreamHost: selected ? upstreamHost(selected) : undefined,
    })

    if (selected) {
      const idx = orderedUpstreams.indexOf(selected)
      if (idx > 0) {
        orderedUpstreams.splice(idx, 1)
        orderedUpstreams.unshift(selected)
      }
    }

    // 依次请求直到成功
    for (const [index, upstream] of orderedUpstreams.entries()) {
      const attemptKind =
        selected && index === 0 && upstream === selected
          ? 'forward'
          : 'fallback'
      try {
        const res = await fetch(upstream + requestPath, {
          method,
          redirect: 'manual',
          headers,
          body,
          signal: AbortSignal.timeout(15000),
        })
        logger.debug('upstream attempt completed', {
          event: 'upstream.attempt',
          upstreamHost: upstreamHost(upstream),
          attempt: index + 1,
          attemptKind,
          status: res.status,
        })
        if (res.status >= 200 && res.status < 400) {
          logger.info('request handled by upstream', {
            event: 'upstream.success',
            upstreamHost: upstreamHost(upstream),
            attempt: index + 1,
            attemptKind,
            status: res.status,
            durationMs: Date.now() - startedAt,
          })
          return res
        }
      } catch (e) {
        logger.debug('upstream attempt errored', {
          event: 'upstream.attempt',
          upstreamHost: upstreamHost(upstream),
          attempt: index + 1,
          attemptKind,
          ...errorProps(e),
        })
      }
      // 仅在当前路由尚未标记该上游失败时才写入，减少重复 KV 写入。
      if (!failedUpstreams.includes(upstream)) {
        failedUpstreams.push(upstream)
        const failKey = `fail:${upstream}|${pathname}`
        waitUntil(kv.put(failKey, '1', { expirationTtl: config.failTtl }))
      }
    }

    // 当前请求未被任何上游成功处理
    logger.error('all upstreams failed to handle request', {
      event: 'request.failed',
      status: 502,
      attemptedUpstreamHosts: orderedUpstreams.map(upstreamHost),
      durationMs: Date.now() - startedAt,
    })
    return new Response('All upstreams failed to handle this request', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
    })
  } catch (e) {
    logger.error('fetchFromUpstream raised an unexpected error', {
      event: 'request.failed',
      status: 502,
      durationMs: Date.now() - startedAt,
      ...errorProps(e),
    })
    return new Response('Internal error', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
    })
  }
}
