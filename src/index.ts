import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { config } from './config'
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
  const upstreamList = upstreams
    .map((u) => `<li><a href="${u}" target="_blank">${u}</a></li>`)
    .join('\n')
  return c.html(html`<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RSSHub Balancer</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #333; }
    h1 { margin-bottom: 0.25rem; }
    ul { padding-left: 1.5rem; list-style: disc; }
    li { margin: 0.25rem 0; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .note { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 0.75rem 1rem; margin-top: 1.5rem; }
    hr { border: none; border-top: 1px solid #d0d7de; margin: 2rem 0; }
  </style>
</head>
<body>
  <h1>RSSHub Balancer</h1>
  <p>为多个 RSSHub 实例做负载均衡，复用缓存响应，减少重复抓取。</p>

  <h2>当前上游实例</h2>
  <p>以下实例自动从 <a href="https://docs.rsshub.app/guide/instances" target="_blank">RSSHub 官方文档</a>同步，另包含一个自维护的兜底实例。</p>
  <ul>
    ${raw(upstreamList)}
  </ul>

  <h2>工作原理</h2>
  <p>本负载均衡器<strong>不会</strong>对上游 RSSHub 实例或被爬取的原始网站造成额外负担：</p>
  <ul>
    <li><strong>两级请求合并</strong> —— 同一时刻对同一路由的多个并发请求会被合并为一次上游请求。第一级在 Worker isolate 内部，共享同一个 Promise；第二级通过 Durable Object 跨 isolate 合并，确保全局只有一个请求发往上游。无论有多少用户同时请求相同的 RSS 源，上游实例只收到一次请求。</li>
    <li><strong>缓存感知路由</strong> —— 在向上游发起实际请求前，先并行检查各实例是否已缓存该路由。优先将请求转发给已有缓存的实例，由其直接返回缓存内容，无需重新抓取原始网站。</li>
    <li><strong>不影响原始网站</strong> —— 每个 RSSHub 实例都有自己的缓存和抓取调度。本均衡器只在 RSSHub 实例层面做分发，从不直接抓取原始网站，也不会改变任何实例的抓取频率。</li>
  </ul>

  <div class="note">
    <p><strong>想要添加或移除你维护的实例？</strong></p>
    <p>请在 <a href="https://github.com/chesha1/rsshub-balancer/issues" target="_blank">GitHub 仓库</a> 提交 Issue。</p>
  </div>

  <hr />

  <h1>RSSHub Balancer</h1>
  <p>Load balancer for multiple RSSHub instances — reuses cached responses and reduces redundant fetching.</p>

  <h2>Current Upstreams</h2>
  <p>Instances below are automatically synced from the <a href="https://docs.rsshub.app/guide/instances" target="_blank">official RSSHub documentation</a>, plus one self-maintained standby instance.</p>
  <ul>
    ${raw(upstreamList)}
  </ul>

  <h2>How It Works</h2>
  <p>This load balancer does <strong>not</strong> impose extra burden on upstream RSSHub instances or the original websites being crawled:</p>
  <ul>
    <li><strong>Two-level request coalescing</strong> — Concurrent requests for the same route are merged into a single upstream request. The first level deduplicates within a Worker isolate by sharing the same Promise; the second level uses a Durable Object to coalesce across isolates, ensuring only one request reaches the upstream globally. No matter how many users request the same RSS feed at the same time, the upstream instance only receives one request.</li>
    <li><strong>Cache-aware routing</strong> — Before making an actual request, the balancer checks all upstream instances in parallel to find one that has already cached the route. The request is then forwarded to the cached instance, which serves its cached content without re-crawling the source website.</li>
    <li><strong>No impact on original websites</strong> — Each RSSHub instance maintains its own cache and crawl schedule. This balancer only distributes requests at the RSSHub instance level; it never crawls original websites directly, nor does it alter any instance's crawl frequency.</li>
  </ul>

  <div class="note">
    <p><strong>Want to add or remove your instance?</strong></p>
    <p>Please open an issue on the <a href="https://github.com/chesha1/rsshub-balancer/issues" target="_blank">GitHub repository</a>.</p>
  </div>
</body>
</html>`)
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
