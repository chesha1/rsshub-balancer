import { honoLogger } from '@logtape/hono'
import type { Logger } from '@logtape/logtape'
import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { v7 as uuidv7 } from 'uuid'
import { config } from './config'
import { renderHome } from './home'
import {
  bindRequestLogger,
  cronLogger,
  errorProps,
  httpLogger,
  REQUEST_ID_HEADER,
  withResponseRequestId,
} from './log'
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

// 这些路径会频繁被探测或访问，保留路由行为但默认不写入口访问日志。
const quietAccessLogExactPaths = new Set([
  '/healthz',
  '/robots.txt',
  '/logo.png',
  '/favicon.ico',
])

// 这类前缀通常属于平台探针或当前未开放的接口，同样默认静默访问日志。
const quietAccessLogPrefixes = ['/api/', '/.well-known/', '/cdn-cgi/']

// 统一注册一批明确不对外提供的路由，避免下面散落多条重复的 notFound 声明。
const notFoundRoutes = [
  '/metrics',
  '/api/*',
  '/.well-known/*',
  '/cdn-cgi/*',
  '/logo.png',
  '/favicon.ico',
] as const

// 访问日志是否静默只由路径决定，方便和具体 middleware 配置解耦。
function shouldSkipAccessLog(path: string) {
  return (
    quietAccessLogExactPaths.has(path) ||
    quietAccessLogPrefixes.some((prefix) => path.startsWith(prefix))
  )
}

const app = new Hono<{
  Bindings: CloudflareBindings
  Variables: {
    logger: Logger
  }
}>()

// 为每个外部请求生成/复用一个 X-Request-Id，作为整条链路的业务关联键。
app.use(
  requestId({
    generator: () => uuidv7(),
  }),
)

// 把 requestId、method、path 绑定到请求级 logger 上，后续 handler 直接复用。
app.use(async (c, next) => {
  const logger = bindRequestLogger(httpLogger, c.get('requestId'), c.req.raw)
  c.set('logger', logger)
  await next()
})

// 统一记录入口访问日志；健康检查和 Cloudflare 自带探针路径默认跳过，减少噪音。
app.use(
  honoLogger({
    category: ['rsshub-balancer', 'http'],
    skip: (c) => shouldSkipAccessLog(c.req.path),
    format: (c, durationMs) => ({
      event: 'http.request',
      requestId: c.res.headers.get(REQUEST_ID_HEADER) ?? undefined,
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
    return withResponseRequestId(response, c.get('requestId'))
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
  const url = new URL(c.req.url)
  const requestPath = url.pathname + url.search
  const method = c.req.method
  const requestId = c.get('requestId')
  const logger = c.get('logger')
  const request = c.req.raw
  const startedAt = Date.now()

  // 非 GET 请求不参与合并，直接转发上游并返回原始 Response
  if (method !== 'GET') {
    return await fetchFromUpstream(
      request,
      c.env.KV,
      // 把失败标记等后台写入交给 waitUntil，避免阻塞当前响应。
      (p) => c.executionCtx.waitUntil(p),
      requestId,
    )
  }

  // GET：两层合并（isolate 级 → Durable Object 级）
  // TODO: 当前只有 leader 的 requestId 会继续进入 DO / upstream。
  // 也就是说 follower 请求虽然能拿到响应，但在日志里找不到自己对应的
  // DO / upstream 链路；后面如果要增强追踪，再把 external requestId 和
  // shared fetch/coalesce id 拆开建模。
  let promise = inflight.get(requestPath)
  let coalesceRole: 'isolate-leader' | 'isolate-follower'
  if (promise) {
    coalesceRole = 'isolate-follower'
    logger.debug('request joined an inflight isolate request', {
      event: 'coalesce.join',
      coalesceRole,
    })
  } else {
    coalesceRole = 'isolate-leader'
    logger.debug('request is leading an isolate coalesced fetch', {
      event: 'coalesce.join',
      coalesceRole,
    })
    promise = (async (): Promise<ResponseSnapshot> => {
      try {
        try {
          const id = c.env.DO.idFromName(requestPath)
          const stub = c.env.DO.get(id)
          return await stub.coalesce(request, requestId)
        } catch (e) {
          const res = await fetchFromUpstream(
            request,
            c.env.KV,
            // 降级直连上游时，仍然沿用同一个 waitUntil 提交后台任务。
            (p) => c.executionCtx.waitUntil(p),
            requestId,
            {
              degradedToDirect: true,
              degradeReason: 'do_rpc_failed',
              degradeError: errorProps(e),
            },
          )
          return await fromResponse(res)
        }
      } finally {
        inflight.delete(requestPath)
      }
    })()
    inflight.set(requestPath, promise)
  }

  const snapshot = await promise
  logger.info('isolate coalescing completed', {
    event: 'coalesce.completed',
    coalesceRole,
    status: snapshot.status,
    durationMs: Date.now() - startedAt,
  })
  return withResponseRequestId(toResponse(snapshot), requestId)
})

export default {
  fetch: app.fetch.bind(app),
  async scheduled(
    _event: ScheduledEvent,
    env: CloudflareBindings,
    _ctx: ExecutionContext,
  ) {
    const startedAt = Date.now()
    let previous: string[] = []
    try {
      const raw = await env.KV.get('instances')
      if (raw) {
        try {
          previous = JSON.parse(raw) as string[]
        } catch {
          previous = []
        }
      }
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
      const previousSet = new Set(previous)
      const healthySet = new Set(healthy)
      const addedHosts = healthy.filter((u) => !previousSet.has(u))
      const removedHosts = previous.filter((u) => !healthySet.has(u))
      if (healthy.length === 0) {
        cronLogger.warn('scheduled refresh found no healthy upstreams', {
          event: 'cron.refresh',
          outcome: 'retain_existing',
          remoteCount: remote.length,
          mergedCount: merged.length,
          healthyCount: 0,
          previousCount: previous.length,
          durationMs: Date.now() - startedAt,
        })
        return
      }
      await env.KV.put('instances', JSON.stringify(healthy))
      cronLogger.info('scheduled refresh updated upstream instances', {
        event: 'cron.refresh',
        outcome: 'updated',
        remoteCount: remote.length,
        mergedCount: merged.length,
        healthyCount: healthy.length,
        previousCount: previous.length,
        addedHosts,
        removedHosts,
        durationMs: Date.now() - startedAt,
      })
    } catch (e) {
      cronLogger.warn('scheduled refresh failed; keeping existing instances', {
        event: 'cron.refresh',
        outcome: 'retain_existing',
        previousCount: previous.length,
        durationMs: Date.now() - startedAt,
        ...errorProps(e),
      })
    }
  },
}
