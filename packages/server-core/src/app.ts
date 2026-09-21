import { Hono } from 'hono'
import { proxy } from 'hono/proxy'
import * as metrics from './metrics'
import { internalRoutes } from './routes/internal'
import * as upstream from './upstream'

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

// 共享路由直接使用业务模块；各应用负责在挂载前注册公共中间件与平台专属路由。
export const routes = new Hono()

routes.route('/_internal', internalRoutes)
routes.get('/healthz', async (c) => {
  const upstreams = await upstream.getUpstreams()
  try {
    await Promise.any(
      upstreams.map(async (u) => {
        const res = await fetch(`${u}/healthz`, {
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) throw new Error(`${res.status}`)
        // 与定时筛选保持一致，只有健康端点返回明确的 ok 正文才算可用。
        if ((await res.text()) !== 'ok')
          throw new Error('Invalid health response')
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
routes.get('/api/route/status', async (c) => {
  const requestPath = c.req.query('requestPath')
  if (!requestPath) {
    return c.text('Missing requestPath parameter', 400)
  }

  const upstreams = await upstream.getUpstreams()
  try {
    const response = await Promise.any(
      upstreams.map(async (upstream) => {
        const statusUrl = `${upstream}/api/route/status?requestPath=${encodeURIComponent(requestPath)}`
        const res = await proxy(statusUrl, {
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
  routes.all(path, (c) => c.notFound())
}

routes.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /'))

routes.all('/*', async (c) => {
  const method = c.req.method
  if (!publicProxyAllowedMethods.has(method)) {
    return c.text('Method Not Allowed', 405, {
      Allow: PUBLIC_PROXY_ALLOW_HEADER,
    })
  }

  const request = c.req.raw
  const requestCountry = metrics.getRequestCountry(request)
  const result = await upstream.fetchFromUpstream(request)
  metrics.recordRouteRequestMetric({
    country: requestCountry,
    upstream: result.upstream ?? 'none',
  })
  return result.response
})
