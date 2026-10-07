import type { Env, Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { v7 as uuidv7 } from 'uuid'
import { withRequestLogContext } from './log'

const noStoreRoutes = ['/healthz', '/_internal/*', '/api/*'] as const

// 转发的正文来自第三方 RSSHub 上游，却以本站域名返回给浏览器。沙箱 CSP 让其中的 HTML 或 XML 无法执行脚本、提交表单或加载外部资源，
// 文档也不再拥有本站源的权限；只放行浏览器内置 XML/JSON 查看器自身需要的内联样式和 data: 图片，RSS 阅读器不受影响。
const RESPONSE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"

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

  // 应用返回的转发、接口和错误响应都不需要在浏览器中执行内容，统一覆盖上游的同名头，并禁止浏览器按内容猜测类型。
  // 首页和 /_assets 由 Worker 静态资源直接返回，不经过这里，响应头见 apps/web/public/_headers。
  app.use(async (c, next) => {
    await next()
    c.header('Content-Security-Policy', RESPONSE_CONTENT_SECURITY_POLICY)
    c.header('X-Content-Type-Options', 'nosniff')
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
