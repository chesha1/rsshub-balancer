import { config } from './config'
import { shuffle } from './utils'

// 按优先级依次尝试上游实例，返回首个成功响应；全部失败时返回 502
export async function fetchFromUpstream(
  request: Request,
  kv: KVNamespace,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const requestPath = url.pathname + url.search
    const pathname = url.pathname
    const method = request.method
    const headers = request.headers
    // 非幂等请求需要缓冲 body 以支持顺序重试
    const body =
      method !== 'GET' && method !== 'HEAD'
        ? await request.arrayBuffer()
        : undefined
    // 并行读取所有上游对当前路由的失败记录
    const failKeys = config.upstreams.map((u) => `fail:${u}|${pathname}`)
    const failResults = await Promise.all(failKeys.map((key) => kv.get(key)))
    const failedUpstreams = config.upstreams.filter((_, i) => failResults[i])

    // 分为 healthy / unhealthy 两组，各组内随机洗牌
    const healthyUpstreams = config.upstreams.filter(
      (u) => !failedUpstreams.includes(u),
    )
    const orderedUpstreams = [
      ...shuffle(healthyUpstreams),
      ...shuffle(failedUpstreams),
    ]

    console.log(
      `[order] healthy=${healthyUpstreams.length} unhealthy=${failedUpstreams.length} order=${orderedUpstreams.map((u) => new URL(u).hostname).join(',')}`,
    )

    // 并行检查所有上游实例的缓存状态
    let selected: string | undefined
    try {
      selected = await Promise.any(
        orderedUpstreams.map(async (upstream) => {
          const statusUrl = `${upstream}/api/route/status?requestPath=${encodeURIComponent(requestPath)}`
          try {
            const check = await fetch(statusUrl)
            console.log(`[cache-check] ${upstream} -> ${check.status}`)
            if (check.status === 200) return upstream
            throw new Error(`${check.status}`)
          } catch (e) {
            console.log(`[cache-check] ${upstream} -> error: ${e}`)
            throw e
          }
        }),
      )
    } catch {
      selected = undefined
    }

    // 有实例已缓存，将其提到队首优先尝试
    if (selected) {
      console.log(`[cache-hit] ${selected}`)
      const idx = orderedUpstreams.indexOf(selected)
      if (idx > 0) {
        orderedUpstreams.splice(idx, 1)
        orderedUpstreams.unshift(selected)
      }
    } else {
      console.log('[cache-miss] 所有上游均未缓存')
    }

    // 依次请求直到成功
    for (const [index, upstream] of orderedUpstreams.entries()) {
      const logTag =
        selected && index === 0 && upstream === selected
          ? 'forward'
          : 'fallback'
      try {
        const res = await fetch(upstream + requestPath, {
          method,
          redirect: 'manual',
          headers,
          body,
        })
        console.log(`[${logTag}] ${upstream} -> ${res.status}`)
        if (res.status >= 200 && res.status < 400) {
          return res
        }
      } catch (e) {
        console.log(`[${logTag}] ${upstream} -> error: ${e}`)
      }
      // 仅在当前路由尚未标记该上游失败时才写入，减少重复 KV 写入。
      if (!failedUpstreams.includes(upstream)) {
        failedUpstreams.push(upstream)
        const failKey = `fail:${upstream}|${pathname}`
        waitUntil(kv.put(failKey, '1', { expirationTtl: config.failTtl }))
      }
    }

    // 所有实例均失败
    console.error('[error] 所有上游均不可用，返回 502')
    return new Response('All upstreams are unavailable', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
    })
  } catch (e) {
    console.error(`[error] fetchFromUpstream 意外异常: ${e}`)
    return new Response('Internal error', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
    })
  }
}
