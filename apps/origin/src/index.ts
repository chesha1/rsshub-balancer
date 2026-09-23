import { once } from 'node:events'
import { serve } from '@hono/node-server'
import { scheduled } from '@rsshub-balancer/server-core'
import { errorProps, runtimeLogger } from '@rsshub-balancer/server-core/log'
import { app } from './app'
import { registerRuntimeWarningLogger } from './log'
import { startMetricsUpload } from './metrics'

// 初始化模块并启动 Node 服务；停止时使用默认信号行为，允许中断请求和丢弃未发送指标。
try {
  registerRuntimeWarningLogger()
  startMetricsUpload(process.env.METRICS_INGEST_URL)

  // 启动和每小时刷新直接复用 scheduled，由它统一处理失败并保留现有列表。
  await scheduled()
  const server = serve({
    hostname: '0.0.0.0',
    port: 3000,
    // 由 Hono 适配器管理 Node 请求和响应对象，代理转发在共享路由中处理。
    fetch: app.fetch,
  })
  await once(server, 'listening')
  setInterval(
    () => {
      void scheduled()
    },
    60 * 60 * 1000,
  )
} catch (error) {
  // 启动错误以结构化日志报告，退出非零供调用方识别。
  runtimeLogger.error('node startup failed', {
    event: 'runtime.startup',
    ...errorProps(error),
  })
  process.exit(1)
}
