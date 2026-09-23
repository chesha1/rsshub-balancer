import { Routes } from 'cloudflare/resources/workers/routes'
import { createClient } from 'cloudflare/tree-shakable'
import { API_TIMEOUT_MS, CATCH_ALL, FailoverError, WORKER_NAME } from './config'

// 使用当前调用的 bindings 创建轻量客户端，不在全局保存凭证。
function createRoutesClient(env: WatchdogBindings) {
  return createClient({
    resources: [Routes],
    apiToken: env.CLOUDFLARE_ROUTES_API_TOKEN,
    baseURL: 'https://api.cloudflare.com/client/v4',
    // 写入结果不确定时由故障切换流程读回确认，SDK 不重复提交。
    maxRetries: 0,
    // 异常统一交给 Cron 入口处理，SDK 不输出请求或响应正文。
    logLevel: 'off',
    fetchOptions: { redirect: 'manual' },
  }).workers.routes
}

// 只查找约定的 catch-all；已被其他脚本占用时停止，不覆盖人工配置。
export async function getCatchAll(env: WatchdogBindings) {
  const { result } = await createRoutesClient(env).list(
    { zone_id: env.CLOUDFLARE_ZONE_ID },
    { signal: AbortSignal.timeout(API_TIMEOUT_MS) },
  )
  const route = result.find((route) => route.pattern === CATCH_ALL)
  if (route && route.script !== WORKER_NAME) {
    throw new FailoverError('unexpected_route_script')
  }
  return route
}

// 一轮只提交一次接管写入；包括超时在内的结果都由调用方重新列出 Routes 核实。
export async function createCatchAll(env: WatchdogBindings): Promise<void> {
  await createRoutesClient(env).create(
    {
      zone_id: env.CLOUDFLARE_ZONE_ID,
      pattern: CATCH_ALL,
      script: WORKER_NAME,
    },
    { signal: AbortSignal.timeout(API_TIMEOUT_MS) },
  )
}

// 删除 ID 由调用方在恢复前重新查询取得；无论请求结果如何，都需要重新读回路由。
export async function deleteCatchAll(
  env: WatchdogBindings,
  routeId: string,
): Promise<void> {
  await createRoutesClient(env).delete(
    routeId,
    { zone_id: env.CLOUDFLARE_ZONE_ID },
    { signal: AbortSignal.timeout(API_TIMEOUT_MS) },
  )
}
