import { runtimeLogger } from '@rsshub-balancer/server-core/log'

type RuntimeWarning = Error & {
  emitter?: unknown
  type?: string
  count?: number
}

let runtimeWarningLoggerRegistered = false

// 从 Node warning 对象中提取 EventEmitter 诊断字段，避免日志里直接展开复杂对象。
function warningProps(warning: RuntimeWarning): Record<string, unknown> {
  const emitter = warning.emitter
  const emitterName =
    emitter && typeof emitter === 'object'
      ? emitter.constructor?.name
      : undefined

  return {
    warningName: warning.name,
    warningMessage: warning.message,
    warningStack: warning.stack,
    emitterName,
    warningType: warning.type,
    listenerCount: warning.count,
  }
}

// 注册一次 Node runtime warning 捕获，用来定位 MaxListenersExceededWarning 的来源。
export function registerRuntimeWarningLogger(): void {
  if (runtimeWarningLoggerRegistered) return
  if (typeof process === 'undefined' || typeof process.on !== 'function') return

  runtimeWarningLoggerRegistered = true
  process.on('warning', (warning: RuntimeWarning) => {
    if (warning.name !== 'MaxListenersExceededWarning') return

    runtimeLogger.warn('runtime emitted max listeners warning', {
      event: 'runtime.warning',
      outcome: 'max_listeners_exceeded',
      ...warningProps(warning),
    })
  })
}
