import { honoLogger } from '@logtape/hono'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { v7 as uuidv7 } from 'uuid'
import { config } from './config'
import {
  cronLogger,
  errorProps,
  getRequestLogContext,
  httpLogger,
  withRequestId,
  withRequestLogContext,
  withResponseRequestId,
} from './log'
import { getRequestColo, getRequestCountry, recordMetric } from './metrics'
import { createStateStore } from './store'
import type { ResponseSnapshot } from './types'
import {
  cacheInstances,
  fetchFromUpstream,
  fetchRemoteInstances,
  getUpstreams,
} from './upstream'
import { fromResponse, toResponse, trimSlash } from './utils'

export { RequestCoalescer } from './coalescer'

type AppEnv = {
  Bindings: CloudflareBindings
}

type AppContext = Context<AppEnv>

// isolate 级请求合并：key 为 method + requestPath，value 为正在进行的上游解析 promise。
// 同一 isolate 内对同一路径同方法的并发 GET/HEAD 请求共享同一个 promise，leader 完成后条目自动清除。
const inflight = new Map<string, Promise<ResponseSnapshot>>()

// 临时降低 Durable Object 参与比例，先保留少量样本观察 Redis timeout 变化。
const DO_SAMPLE_RATE = 0.01

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

// 访问日志是否静默只由路径决定，方便和具体 middleware 配置解耦。
function shouldSkipAccessLog(path: string) {
  return (
    quietAccessLogExactPaths.has(path) ||
    quietAccessLogPrefixes.some((prefix) => path.startsWith(prefix))
  )
}

// 从公开 UI 数据命名空间返回当前上游列表，响应中不暴露状态存储错误细节。
async function handleInternalUpstreams(c: AppContext) {
  if (c.req.method !== 'GET') {
    return c.text('Method Not Allowed', 405, {
      Allow: 'GET',
    })
  }

  const url = new URL(c.req.url)
  if (url.search !== '') {
    return c.json({ error: 'bad_request' }, 400)
  }

  try {
    const upstreams = await getUpstreams(createStateStore(c.env), {
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    })
    return c.json({ upstreams })
  } catch (e) {
    httpLogger.warn('public upstream list request failed', {
      event: 'internal.upstreams',
      outcome: 'failed',
      ...errorProps(e),
    })
    return c.json({ error: 'internal_error' }, 500)
  }
}

const app = new Hono<AppEnv>()

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

app.all('/_internal/upstreams', handleInternalUpstreams)
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
    return withResponseRequestId(response)
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
  const coalesceKey = `${method} ${requestPath}`
  const request = c.req.raw
  const requestCountry = getRequestCountry(request)
  const requestColo = getRequestColo(request)
  const startedAt = Date.now()
  const stateStore = createStateStore(c.env)

  // GET/HEAD 是安全方法，参与两级请求合并；其他方法直接转发上游并返回原始 Response。
  if (method !== 'GET' && method !== 'HEAD') {
    const result = await fetchFromUpstream(
      request,
      stateStore,
      // 把失败标记等后台写入交给 waitUntil，避免阻塞当前响应。
      (p) => c.executionCtx.waitUntil(p),
    )
    const { response: res } = result
    const durationMs = Date.now() - startedAt
    recordMetric(c.env.METRICS, {
      metric: 'route_request',
      layer: 'edge',
      method,
      status: res.status,
      durationMs,
      country: requestCountry,
      edgeColo: requestColo,
    })
    recordMetric(c.env.METRICS, {
      metric: 'direct_upstream',
      layer: 'edge',
      method,
      reason: 'non_get',
      status: res.status,
      durationMs,
      upstream: result.upstream,
    })
    return res
  }

  // GET/HEAD：两层合并（isolate 级 → Durable Object 级）。
  // TODO: 当前只有 leader 的请求上下文会继续进入 DO / upstream。
  // 也就是说 follower 请求虽然能拿到响应，但在日志里找不到自己对应的
  // DO / upstream 链路；后面如果要增强追踪，再把 external requestId 和
  // shared fetch/coalesce id 拆开建模。
  let promise = inflight.get(coalesceKey)
  let coalesceRole: 'isolate-leader' | 'isolate-follower'
  if (promise) {
    coalesceRole = 'isolate-follower'
    httpLogger.debug('request joined an inflight isolate request', {
      event: 'coalesce.join',
      coalesceRole,
    })
  } else {
    coalesceRole = 'isolate-leader'
    httpLogger.debug('request is leading an isolate coalesced fetch', {
      event: 'coalesce.join',
      coalesceRole,
    })
    promise = (async (): Promise<ResponseSnapshot> => {
      try {
        let directReason: 'do_sampled_out' | 'do_rpc_failed' = 'do_sampled_out'
        let degradeError: Record<string, unknown> | undefined

        // 只让少量 isolate leader 继续进入 DO，用最小改动降低 DO 内 Redis 访问压力。
        if (Math.random() < DO_SAMPLE_RATE) {
          try {
            const id = c.env.DO.idFromName(coalesceKey)
            const stub = c.env.DO.get(id)
            return await stub.coalesce(withRequestId(request))
          } catch (e) {
            directReason = 'do_rpc_failed'
            degradeError = errorProps(e)
          }
        }

        const result = await fetchFromUpstream(
          request,
          stateStore,
          // 降级直连上游时，仍然沿用同一个 waitUntil 提交后台任务。
          (p) => c.executionCtx.waitUntil(p),
          {
            degradedToDirect: true,
            degradeReason: directReason,
            ...(degradeError ? { degradeError } : {}),
          },
        )
        const snapshot = await fromResponse(result.response)
        recordMetric(c.env.METRICS, {
          metric: 'direct_upstream',
          layer: 'isolate',
          role: 'leader',
          method,
          reason: directReason,
          status: snapshot.status,
          durationMs: Date.now() - startedAt,
          upstream: result.upstream,
        })
        return snapshot
      } finally {
        inflight.delete(coalesceKey)
      }
    })()
    inflight.set(coalesceKey, promise)
  }

  const snapshot = await promise
  const durationMs = Date.now() - startedAt
  const coalesceRoleMetric =
    coalesceRole === 'isolate-leader' ? 'leader' : 'follower'
  recordMetric(c.env.METRICS, {
    metric: 'route_request',
    layer: 'edge',
    method,
    status: snapshot.status,
    durationMs,
    country: requestCountry,
    edgeColo: requestColo,
  })
  recordMetric(c.env.METRICS, {
    metric: 'coalesce_role',
    layer: 'isolate',
    role: coalesceRoleMetric,
    method,
    reason: coalesceRole === 'isolate-follower' ? 'isolate_follower' : 'none',
    status: snapshot.status,
    durationMs,
  })
  if (coalesceRole === 'isolate-follower') {
    recordMetric(c.env.METRICS, {
      metric: 'benefited',
      layer: 'isolate',
      role: 'follower',
      method,
      reason: 'isolate_follower',
      status: snapshot.status,
      durationMs,
    })
  }
  httpLogger.info('isolate coalescing completed', {
    event: 'coalesce.completed',
    coalesceRole,
    status: snapshot.status,
    durationMs,
  })
  return withResponseRequestId(
    toResponse(snapshot, { includeBody: method !== 'HEAD' }),
  )
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
    const stateStore = createStateStore(env)
    try {
      try {
        previous = (await stateStore.getInstances()) ?? []
      } catch {}
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
      await stateStore.setInstances(healthy)
      cacheInstances(healthy)
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
