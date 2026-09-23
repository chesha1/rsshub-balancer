import { APIError } from 'cloudflare'
import { FailoverError } from './config'
import { runFailover } from './failover'

export default {
  // 每次定时触发执行一轮检查，失败由 Cron 记录异常。
  async scheduled(_controller, env) {
    try {
      await runFailover(env)
    } catch (error) {
      // SDK 错误可能包含外部正文；只保留 HTTP 状态或请求失败类别。
      if (error instanceof APIError) {
        throw new Error(`cloudflare_api_${error.status ?? 'request_failed'}`)
      }
      // 业务错误码可直接报告，其他异常统一隐藏原始内容。
      throw error instanceof FailoverError ? error : new Error('request_failed')
    }
  },
} satisfies ExportedHandler<WatchdogBindings>
