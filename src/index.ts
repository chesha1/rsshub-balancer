import { Hono } from 'hono'
import { config } from './config'

const app = new Hono()
app.all('/', (c) => c.text('RSSHub Balancer'))
app.all('/logo.png', (c) => c.notFound())
app.all('/favicon.ico', (c) => c.notFound())

app.all('/*', async (c) => {
  const url = new URL(c.req.url)
  const requestPath = url.pathname + url.search

  console.log(`[request] ${c.req.method} ${requestPath}`)

  // 遍历所有上游实例，通过 RSSHub 路由状态接口检测哪个实例已缓存该路由
  // 找到第一个可用（返回 200）的实例即选中，避免重复抓取
  let selected: string | undefined
  for (const upstream of config.upstreams) {
    try {
      // 调用 RSSHub 路由状态 API，判断该实例是否已缓存当前请求路径
      // https://github.com/DIYgod/RSSHub/pull/21300
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
  for (const upstream of config.upstreams) {
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
    } catch (e) {
      console.log(`[fallback] ${upstream} -> error: ${e}`)
    }
  }

  // 所有实例均失败
  console.log('[error] 所有上游均不可用，返回 502')
  return c.text('All upstreams are unavailable', 502)
})

export default app
