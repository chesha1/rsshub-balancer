import { Hono } from 'hono'
import { config } from './config'

const app = new Hono()

app.all('/*', async (c) => {
  const url = new URL(c.req.url)
  const requestPath = url.pathname + url.search

  let selected: string | undefined
  for (const upstream of config.upstreams) {
    try {
      // https://github.com/DIYgod/RSSHub/pull/21300
      const statusUrl = `${upstream}/api/route/status?requestPath=${encodeURIComponent(requestPath)}`
      const check = await fetch(statusUrl)
      if (check.status === 200) {
        selected = upstream
        break
      }
    } catch {
      // upstream 不可用，尝试下一个
    }
  }

  if (!selected) {
    selected = config.fallbackUpstream
  }

  const res = await fetch(selected + requestPath, {
    method: c.req.method,
    headers: c.req.raw.headers,
  })

  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  })
})

export default app
