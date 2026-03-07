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

  console.log(`[request] ${c.req.method} ${requestPath}`)

  // 并行读取所有上游对当前路由的失败记录
  const failKeys = config.upstreams.map((u) => `fail:${u}|${url.pathname}`)
  const failResults = await Promise.all(failKeys.map((key) => env.KV.get(key)))

  // 分为 healthy / unhealthy 两组，各组内随机洗牌
  const healthy: string[] = []
  const unhealthy: string[] = []
  for (let i = 0; i < config.upstreams.length; i++) {
    if (failResults[i]) {
      unhealthy.push(config.upstreams[i])
    } else {
      healthy.push(config.upstreams[i])
    }
  }
  const orderedUpstreams = [...shuffle(healthy), ...shuffle(unhealthy)]

  console.log(
    `[order] healthy=${healthy.length} unhealthy=${unhealthy.length} order=${orderedUpstreams.map((u) => new URL(u).hostname).join(',')}`,
  )

  // 遍历所有上游实例，通过 RSSHub 路由状态接口检测哪个实例已缓存该路由
  let selected: string | undefined
  for (const upstream of orderedUpstreams) {
    try {
      const statusUrl = `${upstream}/api/route/status?requestPath=${encodeURIComponent(requestPath)}`
      const check = await fetch(statusUrl)
      console.log(`[cache-check] ${upstream} -> ${check.status}`)
      if (check.status === 200) {
        selected = upstream
        break
      }
    } catch (e) {
      console.log(`[cache-check] ${upstream} -> error: ${e}`)
    }
  }

  // 有实例已缓存，直接请求
  if (selected) {
    console.log(`[cache-hit] ${selected}`)
    const res = await fetch(selected + requestPath, {
      method: c.req.method,
      headers: c.req.raw.headers,
    })
    console.log(`[response] ${selected} -> ${res.status}`)
    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    })
  }

  console.log('[cache-miss] 所有上游均未缓存，依次尝试请求')

  // 所有上游均未缓存时，依次请求直到成功
  for (const upstream of orderedUpstreams) {
    try {
      const res = await fetch(upstream + requestPath, {
        method: c.req.method,
        headers: c.req.raw.headers,
      })
      console.log(`[fallback] ${upstream} -> ${res.status}`)
      if (res.ok) {
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        })
      }
      // 请求失败，异步写入 KV 失败记录
      const failKey = `fail:${upstream}|${url.pathname}`
      c.executionCtx.waitUntil(
        env.KV.put(failKey, '1', { expirationTtl: config.failTtl }),
      )
    } catch (e) {
      console.log(`[fallback] ${upstream} -> error: ${e}`)
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
