import {
  FailoverError,
  HOST,
  NODE_HOST,
  PROBE_ATTEMPTS,
  RETRY_DELAY_MS,
} from './config'
import { probe } from './probe'
import { createCatchAll, deleteCatchAll, getCatchAll } from './routes'

// 重新读取后只创建一次接管 Route，读回确认后结束本轮。
async function takeOver(env: WatchdogBindings): Promise<void> {
  if (await getCatchAll(env)) return
  try {
    await createCatchAll(env)
  } catch {
    // POST 超时也可能已生效；统一读回确认，不重复写入。
  }
  if (!(await getCatchAll(env))) {
    throw new FailoverError('takeover_not_confirmed')
  }
  console.log('takeover_route_created')
}

// 只删除刚读回的接管 Route；本轮不反向切换，恢复后的业务状态留给下一轮检查。
async function restoreOrigin(env: WatchdogBindings): Promise<void> {
  const route = await getCatchAll(env)
  if (!route) return
  try {
    await deleteCatchAll(env, route.id)
  } catch {
    // DELETE 超时也可能已生效；读回失败就报错，下一轮重新判断实际状态。
  }
  if (await getCatchAll(env)) {
    throw new FailoverError('recovery_not_confirmed')
  }
  console.log('takeover_route_deleted')
}

// 未接管时检查主域名，接管时检查固定源站；连续两次满足条件后最多切换一次。
export async function runFailover(env: WatchdogBindings): Promise<void> {
  const hasCatchAll = Boolean(await getCatchAll(env))
  const host = hasCatchAll ? NODE_HOST : HOST
  // 固定源站必须来自 origin；公开入口允许切换传播期间仍由已知的 edge 响应。
  const allowedApps = hasCatchAll ? ['origin'] : ['origin', 'edge']
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    const result = await probe(host)
    // 无标识的失败可能来自边缘代理；未知来源或健康响应缺少标识仍按配置错误处理。
    if (
      (result.app !== null && !allowedApps.includes(result.app)) ||
      (result.healthy && result.app === null)
    ) {
      throw new FailoverError(
        hasCatchAll
          ? 'origin_source_not_confirmed'
          : 'public_source_not_confirmed',
      )
    }
    if (hasCatchAll && !result.healthy) return
    if (!hasCatchAll && result.healthy) return
    if (attempt < PROBE_ATTEMPTS) {
      await scheduler.wait(RETRY_DELAY_MS)
    }
  }
  if (hasCatchAll) await restoreOrigin(env)
  else await takeOver(env)
}
