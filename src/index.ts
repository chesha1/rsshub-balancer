import { Hono } from 'hono'
import type { ResponseSnapshot } from './types'
import { fetchFromUpstream } from './upstream'
import { fromResponse, toResponse } from './utils'

export { RequestCoalescer } from './coalescer'

// isolate 级请求合并：key 为 requestPath（pathname + search），value 为正在进行的上游解析 promise。
// 同一 isolate 内对同一路径的并发 GET 请求共享同一个 promise，leader 完成后条目自动清除。
const inflight = new Map<string, Promise<ResponseSnapshot>>()

const app = new Hono<{ Bindings: CloudflareBindings }>()
app.all('/', (c) => c.text('RSSHub Balancer'))
app.all('/logo.png', (c) => c.notFound())
app.all('/favicon.ico', (c) => c.notFound())

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

export default app
