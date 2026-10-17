import { Hono } from 'hono'
import { proxy } from 'hono/proxy'
import { readCacheStatus } from './cache-status'
import * as metrics from './metrics'
import { internalRoutes } from './routes/internal'
import * as upstream from './upstream'
import { cancelResponseBody, isLocalResourcePath } from './utils'

// 统一注册一批明确不对外提供的路由，避免下面散落多条重复的 notFound 声明。
// 本站资源（/_assets 目录与根目录静态文件）由代理入口通过 isLocalResourcePath() 统一判断，不在这里重复声明。
const notFoundRoutes = [
  '/_internal/*',
  '/metrics',
  '/api/*',
  '/.well-known/*',
  '/cdn-cgi/*',
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
        if (!res.ok) {
          await cancelResponseBody(res)
          throw new Error(`${res.status}`)
        }
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
  const probes = new AbortController()
  try {
    let hasWinner = false
    return await Promise.any(
      upstreams.map(async (upstream) => {
        const statusUrl = `${upstream}/api/route/status?requestPath=${encodeURIComponent(requestPath)}`
        const signal = AbortSignal.any([
          AbortSignal.timeout(5000),
          probes.signal,
        ])
        const res = await proxy(statusUrl, {
          signal,
        })
        const status = await readCacheStatus(res)
        // 完成正文校验后同步确定唯一获胜者；其余请求及正文读取立即取消。
        if (status && !hasWinner) {
          hasWinner = true
          probes.abort()
          return c.json(status)
        }
        throw new Error('Unconfirmed cache status')
      }),
    )
  } catch {
    return c.json({ cached: false, lastBuildDate: null }, 404)
  } finally {
    probes.abort()
  }
})

// 这些路径要么由平台占用，要么当前明确不对外提供，统一直接返回 404。
for (const path of notFoundRoutes) {
  routes.all(path, (c) => c.notFound())
}

routes.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /'))

routes.all('/*', async (c) => {
  // 本站资源在进入代理前结束，不触发上游探测、转发、失败标记或 RSS 指标。
  if (isLocalResourcePath(c.req.path)) return c.notFound()

  const method = c.req.method
  if (!publicProxyAllowedMethods.has(method)) {
    return c.text('Method Not Allowed', 405, {
      Allow: PUBLIC_PROXY_ALLOW_HEADER,
    })
  }

  const request = c.req.raw
  const requestDimensions = metrics.getRequestDimensions(request)
  const result = await upstream.fetchFromUpstream(request)
  metrics.recordRouteRequestMetric({
    ...requestDimensions,
    // 按请求最终结果计数，实际尝试失败和失败缓存拦截统一归入失败节点。
    upstream: result.upstream ?? 'failed',
  })
  return result.response
})
