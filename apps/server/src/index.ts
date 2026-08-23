import { honoLogger } from '@logtape/hono'
import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { v7 as uuidv7 } from 'uuid'
import { config } from './config'
import { getRequestLogContext, withRequestLogContext } from './log'
import {
  getRequestColo,
  getRequestCountry,
  recordRouteRequestMetric,
} from './metrics'
import internalRoutes from './routes/internal'
import { scheduled } from './scheduled'
import { createStateStore } from './store'
import type { AppEnv } from './types'
import { fetchFromUpstream, getUpstreams } from './upstream'
import {
  WORKERS_CACHE_BYPASS,
  WORKERS_CACHE_CONTROL_HEADER,
  withPublicProxyCachePolicy,
} from './workers-cache'

// 临时把一部分公开代理请求前置直转 fallback，用代码常量控制月底账单保护比例。
const DIRECT_FALLBACK_RATE = 0

// 这些路径会频繁被探测或访问，保留路由行为但默认不写入口访问日志。
const quietAccessLogExactPaths = new Set([
  '/healthz',
  '/robots.txt',
  '/logo.png',
  '/favicon.ico',
])

// 这类前缀通常属于平台探针或当前未开放的接口，同样默认静默访问日志。
const quietAccessLogPrefixes = [
  '/_assets/',
  '/api/',
  '/.well-known/',
  '/cdn-cgi/',
]

// 统一注册一批明确不对外提供的路由，避免下面散落多条重复的 notFound 声明。
const notFoundRoutes = [
  '/_assets/*',
  '/_internal/*',
  '/metrics',
  '/api/*',
  '/.well-known/*',
  '/cdn-cgi/*',
  '/logo.png',
  '/favicon.ico',
] as const

const publicProxyAllowedMethods = new Set(['GET', 'HEAD'])
const PUBLIC_PROXY_ALLOW_HEADER = 'GET, HEAD'

// 访问日志是否静默只由路径决定，方便和具体 middleware 配置解耦。
function shouldSkipAccessLog(path: string) {
  return (
    quietAccessLogExactPaths.has(path) ||
    quietAccessLogPrefixes.some((prefix) => path.startsWith(prefix))
  )
}

const app = new Hono<AppEnv>()

// 可观测性注意：Workers Cache HIT 会在 Worker 执行前直接返回，不会进入下方访问日志和 Analytics Engine 指标。
// 因此首页最近 24 小时数据只反映 MISS、BYPASS 和刷新等实际执行请求；总流量与命中情况以 Cloudflare 平台侧缓存状态为准。
// Workers Cache 会对缺少缓存头的 200/404 响应应用启发式 TTL；未明确放行的路由统一禁止写入。
app.use(async (c, next) => {
  await next()
  if (!c.res.headers.has(WORKERS_CACHE_CONTROL_HEADER)) {
    c.header(WORKERS_CACHE_CONTROL_HEADER, WORKERS_CACHE_BYPASS)
  }
})

// 为每个外部请求生成/复用一个 X-Request-Id，作为整条链路的业务关联键。
app.use(
  requestId({
    generator: () => uuidv7(),
  }),
)

// 把 requestId、method、path 绑定到当前异步请求上下文，后续任意 logger 都能自动复用。
app.use(async (c, next) => {
  const requestId = c.get('requestId')
  await withRequestLogContext(
    {
      requestId,
      layer: 'edge',
      ...getRequestLogContext(c.req.raw),
    },
    next,
  )
})

// 统一记录入口访问日志；健康检查和 Cloudflare 自带探针路径默认跳过，减少噪音。
app.use(
  honoLogger({
    category: ['rsshub-balancer', 'http'],
    skip: (c) => shouldSkipAccessLog(c.req.path),
    format: (c, durationMs) => ({
      event: 'http.request',
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs,
      contentLength: c.res.headers.get('content-length') ?? undefined,
      userAgent: c.req.header('user-agent') ?? undefined,
      referrer:
        c.req.header('referrer') ?? c.req.header('referer') ?? undefined,
    }),
  }),
)

app.route('/_internal', internalRoutes)
app.get('/healthz', async (c) => {
  const upstreams = await getUpstreams(createStateStore(c.env), {
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  })
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

  const upstreams = await getUpstreams(createStateStore(c.env), {
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  })
  try {
    const response = await Promise.any(
      upstreams.map(async (upstream) => {
        const statusUrl = `${upstream}/api/route/status?requestPath=${encodeURIComponent(requestPath)}`
        const res = await fetch(statusUrl, {
          signal: AbortSignal.timeout(5000),
        })
        if (res.status === 200) return res
        throw new Error(`${res.status}`)
      }),
    )
    return response
  } catch {
    return c.json({ cached: false, lastBuildDate: null }, 404)
  }
})

// 这些路径要么由平台占用，要么当前明确不对外提供，统一直接返回 404。
for (const path of notFoundRoutes) {
  app.all(path, (c) => c.notFound())
}

app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /'))

app.all('/*', async (c) => {
  const method = c.req.method
  if (!publicProxyAllowedMethods.has(method)) {
    return c.text('Method Not Allowed', 405, {
      Allow: PUBLIC_PROXY_ALLOW_HEADER,
    })
  }

  const url = new URL(c.req.url)
  const requestPath = url.pathname + url.search
  const request = c.req.raw

  // 这是为了临时节约本月账单的前置旁路，月底压力解除后应删除或降到 0。
  // 这里不是安全随机，只用最低成本做请求级临时分流，尽量避开后面的 JS 调度链路。
  if (Math.random() < DIRECT_FALLBACK_RATE) {
    const fallbackUpstream = config.fallbackUpstreams[0]
    try {
      const response = await fetch(fallbackUpstream + requestPath, {
        method,
        redirect: 'manual',
        headers: request.headers,
        signal: AbortSignal.timeout(15000),
      })
      return withPublicProxyCachePolicy(request, response)
    } catch {
      return new Response(
        method === 'HEAD' ? null : 'Fallback upstream failed',
        {
          status: 502,
          headers: { 'content-type': 'text/plain; charset=UTF-8' },
        },
      )
    }
  }

  const requestCountry = getRequestCountry(request)
  const requestColo = getRequestColo(request)
  const startedAt = Date.now()
  const stateStore = createStateStore(c.env)
  const result = await fetchFromUpstream(request, stateStore, (p) =>
    c.executionCtx.waitUntil(p),
  )
  const durationMs = Date.now() - startedAt
  recordRouteRequestMetric(c.env.METRICS, {
    method,
    status: result.response.status,
    durationMs,
    outcome: 'direct_upstream',
    upstream: result.upstream,
    country: requestCountry,
    edgeColo: requestColo,
  })
  return withPublicProxyCachePolicy(request, result.response)
})

export default {
  fetch: app.fetch.bind(app),
  scheduled,
}
