import { Hono } from 'hono'
import { config } from './config'
import { shuffle } from './utils'

const app = new Hono<{ Bindings: CloudflareBindings }>()
app.all('/', (c) => c.text('RSSHub Balancer'))
app.all('/logo.png', (c) => c.notFound())
app.all('/favicon.ico', (c) => c.notFound())

app.all('/*', async (c) => {
  const url = new URL(c.req.url)
  const requestPath = url.pathname + url.search
  const env = c.env
  const method = c.req.method
  // 原始请求体是一次性流，先缓冲下来才能安全地重试多个上游。
  const requestBody =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : await c.req.raw.arrayBuffer()

  console.log(`[request] ${method} ${requestPath}`)

  // 并行读取所有上游对当前路由的失败记录
  const failKeys = config.upstreams.map((u) => `fail:${u}|${url.pathname}`)
  const failResults = await Promise.all(failKeys.map((key) => env.KV.get(key)))
  const failedUpstreams = config.upstreams.filter((_, i) => failResults[i])

  // 分为 healthy / unhealthy 两组，各组内随机洗牌
  const healthy = config.upstreams.filter((u) => !failedUpstreams.includes(u))
  const unhealthy = [...failedUpstreams]
  const orderedUpstreams = [...shuffle(healthy), ...shuffle(unhealthy)]

  console.log(
    `[order] healthy=${healthy.length} unhealthy=${unhealthy.length} order=${orderedUpstreams.map((u) => new URL(u).hostname).join(',')}`,
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
      selected && index === 0 && upstream === selected ? 'forward' : 'fallback'
    try {
      const res = await fetch(upstream + requestPath, {
        method,
        // 保留上游 3xx 响应给客户端，避免 Worker 在内部自动跟随重定向并改变可见的 HTTP 语义。
        redirect: 'manual',
        // 在 Cloudflare Workers 中，子请求的 Host 由 fetch 目标 URL 决定，不会透传当前 Worker 的 Host。
        headers: c.req.raw.headers,
        body: requestBody,
      })
      console.log(`[${logTag}] ${upstream} -> ${res.status}`)
      if (res.status >= 200 && res.status < 400) {
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        })
      }
    } catch (e) {
      console.log(`[${logTag}] ${upstream} -> error: ${e}`)
    }
    // 仅在当前路由尚未标记该上游失败时才写入，减少重复 KV 写入。
    // 这里故意不续期 TTL，让失败标记保持固定冷却窗，以进一步压低 KV 写入压力。
    if (!failedUpstreams.includes(upstream)) {
      failedUpstreams.push(upstream)
      const failKey = `fail:${upstream}|${url.pathname}`
      c.executionCtx.waitUntil(
        env.KV.put(failKey, '1', { expirationTtl: config.failTtl }),
      )
    }
  }

  // 所有实例均失败
  console.log('[error] 所有上游均不可用，返回 502')
  return c.text('All upstreams are unavailable', 502)
})

export default app
