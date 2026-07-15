import { config } from './config'

export const WORKERS_CACHE_CONTROL_HEADER = 'Cloudflare-CDN-Cache-Control'
export const WORKERS_CACHE_BYPASS = 'no-store'

const upstreamCacheControlHeaders = [
  'cloudflare-cdn-cache-control',
  'cdn-cache-control',
  'cache-control',
] as const

const upstreamCacheBypassDirectives = new Set([
  'private',
  'no-store',
  'no-cache',
  'must-revalidate',
  'proxy-revalidate',
  // s-maxage 隐含 proxy-revalidate，不能安全地改写为允许陈旧响应的本地策略。
  's-maxage',
])

// 业务前提：此 LB 只服务公开、与身份无关的 RSS；请求不会携带 Authorization/Cookie，上游也不会据此返回差异内容。
// 此检查仅在 MISS、BYPASS 或刷新等 Worker 实际执行时防御性阻止入缓存；HIT 在执行前返回，无法在这里拦截。
// 若未来引入认证或 Cookie，必须在不缓存的 gateway 中前置处理并重新设计缓存隔离，不能继续依赖这个前提。
function isPublicProxyResponseCacheable(
  request: Request,
  response: Response,
): boolean {
  if (response.status !== 200 && response.status !== 304) return false
  if (request.headers.has('authorization') || request.headers.has('cookie')) {
    return false
  }
  if (response.headers.has('set-cookie')) return false

  const upstreamCacheControl = upstreamCacheControlHeaders
    .map((header) => response.headers.get(header))
    .find((value) => value !== null)
  if (!upstreamCacheControl) return false

  const upstreamDirectives = new Map(
    upstreamCacheControl.split(',').map((directive) => {
      const [rawName, rawValue] = directive.trim().toLowerCase().split('=', 2)
      return [rawName, rawValue] as const
    }),
  )
  if (!upstreamDirectives.has('public')) return false
  if (
    [...upstreamCacheBypassDirectives].some((directive) =>
      upstreamDirectives.has(directive),
    )
  ) {
    return false
  }

  return upstreamDirectives.get('max-age') !== '0'
}

// 克隆上游响应头并附加 Workers Cache 策略，同时保持响应体以流式方式透传。
export function withPublicProxyCachePolicy(
  request: Request,
  response: Response,
): Response {
  const headers = new Headers(response.headers)
  headers.set(
    WORKERS_CACHE_CONTROL_HEADER,
    isPublicProxyResponseCacheable(request, response)
      ? config.publicProxyCacheControl
      : WORKERS_CACHE_BYPASS,
  )

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
