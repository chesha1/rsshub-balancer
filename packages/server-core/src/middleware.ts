import type { Env, Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { v7 as uuidv7 } from 'uuid'
import { withRequestLogContext } from './log'

const noStoreRoutes = ['/healthz', '/_internal/*', '/api/*'] as const

// 两端先注册公共中间件，再挂载平台专属路由和共享路由，保证错误响应也继承响应头。
export function registerCommonMiddleware<E extends Env>(app: Hono<E>): void {
  // 可观测性注意：Workers Cache HIT 会在 Worker 执行前直接返回，不会进入下方请求处理和 Analytics Engine 指标。
  // 因此首页最近 24 小时数据只反映 MISS、BYPASS 和刷新等实际执行请求；总流量与命中情况以 Cloudflare 平台侧缓存状态为准。
  // 实时接口按路径禁止写入 Workers Cache；其它路径完全沿用上游或 Cloudflare 默认策略。
  for (const path of noStoreRoutes) {
    app.use(path, async (c, next) => {
      await next()
      c.header('Cache-Control', 'no-store')
      c.header('Cloudflare-CDN-Cache-Control', 'no-store')
    })
  }

  // 为每个外部请求生成/复用一个 X-Request-Id，作为整条链路的业务关联键。
  app.use(
    requestId({
      generator: () => uuidv7(),
    }),
  )

  // 把 requestId、method、path 绑定到当前异步请求上下文，后续任意 logger 都能自动复用。
  app.use(async (c, next) => {
    const requestId = c.get('requestId')
    const url = new URL(c.req.url)
    await withRequestLogContext(
      {
        requestId,
        requestMethod: c.req.method,
        requestPath: url.pathname + url.search,
      },
      next,
    )
    // 原始代理响应会替换预置头，完成业务后补回日志关联 ID。
    c.header('X-Request-Id', requestId)
  })
}
