import { Hono } from 'hono'
import { config } from './config'
import { renderHome } from './home'
import type { ResponseSnapshot } from './types'
import {
  fetchFromUpstream,
  fetchRemoteInstances,
  getUpstreams,
} from './upstream'
import { fromResponse, toResponse, trimSlash } from './utils'

export { RequestCoalescer } from './coalescer'

// isolate 级请求合并：key 为 requestPath（pathname + search），value 为正在进行的上游解析 promise。
// 同一 isolate 内对同一路径的并发 GET 请求共享同一个 promise，leader 完成后条目自动清除。
const inflight = new Map<string, Promise<ResponseSnapshot>>()

const app = new Hono<{ Bindings: CloudflareBindings }>()
app.all('/', async (c) => {
  const upstreams = await getUpstreams(c.env.KV)
  return c.html(renderHome(upstreams))
})
app.get('/healthz', async (c) => {
  const upstreams = await getUpstreams(c.env.KV)
  try {
    await Promise.any(
      upstreams.map(async (u) => {
        const res = await fetch(`${u}/healthz`, {
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) throw new Error(`${res.status}`)
      }),
    )
    return c.text('ok')
  } catch {
    return c.text('unhealthy', 503)
  }
})
// /api/route/status 是元数据查询接口，不走通用转发逻辑：
// 1. 无需缓存检查（本身就是缓存检查）
// 2. 非 200 响应（"未缓存"）是正常结果，不应视为上游失败
app.get('/api/route/status', async (c) => {
  const requestPath = c.req.query('requestPath')
  if (!requestPath) {
    return c.text('Missing requestPath parameter', 400)
  }

  const upstreams = await getUpstreams(c.env.KV)
  try {
    return await Promise.any(
      upstreams.map(async (upstream) => {
        const statusUrl = `${upstream}/api/route/status?requestPath=${encodeURIComponent(requestPath)}`
        const res = await fetch(statusUrl, {
          signal: AbortSignal.timeout(5000),
        })
        if (res.status === 200) return res
        throw new Error(`${res.status}`)
      }),
    )
  } catch {
    return c.json({ cached: false, lastBuildDate: null }, 404)
  }
})

app.all('/.well-known/*', (c) => c.notFound())
app.all('/cdn-cgi/*', (c) => c.notFound())
app.all('/logo.png', (c) => c.notFound())
app.all('/favicon.ico', (c) => c.notFound())
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /'))

app.all('/*', async (c) => {
  const url = new URL(c.req.url)
  const requestPath = url.pathname + url.search
  const method = c.req.method

  console.log(`[request] ${method} ${requestPath}`)

  // 非 GET 请求不参与合并，直接转发上游并返回原始 Response
  if (method !== 'GET') {
    return await fetchFromUpstream(c.req.raw, c.env.KV, (p) =>
      c.executionCtx.waitUntil(p),
    )
  }

  // GET：两层合并（isolate 级 → Durable Object 级）
  let promise = inflight.get(requestPath)
  if (promise) {
    console.log(`[coalesce] isolate-follower ${requestPath}`)
  } else {
    console.log(`[coalesce] isolate-leader ${requestPath}`)
    promise = (async (): Promise<ResponseSnapshot> => {
      try {
        const id = c.env.DO.idFromName(requestPath)
        const stub = c.env.DO.get(id)
        return await stub.coalesce(c.req.raw)
      } catch (e) {
        console.error(`[error] DO RPC failed, 降级为直接请求上游: ${e}`)
        const res = await fetchFromUpstream(c.req.raw, c.env.KV, (p) =>
          c.executionCtx.waitUntil(p),
        )
        return await fromResponse(res)
      }
    })().finally(() => inflight.delete(requestPath))
    inflight.set(requestPath, promise)
  }

  return toResponse(await promise)
})

export default {
  fetch: app.fetch.bind(app),
  async scheduled(
    _event: ScheduledEvent,
    env: CloudflareBindings,
    _ctx: ExecutionContext,
  ) {
    try {
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
      console.log(
        `[scheduled] 健康检查: ${healthy.length}/${merged.length} 可用`,
      )
      if (healthy.length === 0) {
        console.warn('[scheduled] 所有实例均不可用，保留 KV 中已有数据')
        return
      }
      await env.KV.put('instances', JSON.stringify(healthy))
      console.log(`[scheduled] 实例列表已更新，共 ${healthy.length} 个实例`)
    } catch (e) {
      console.warn(`[scheduled] 获取远程实例失败，保留 KV 中已有数据: ${e}`)
    }
  },
}
