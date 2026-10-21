import {
  reportUpstreamIssue,
  safeDiagnosticError,
  type UpstreamDiagnosticTrace,
} from './upstream-observability'
import { cancelResponseBody } from './utils'

type HealthProbeOptions = {
  signal: AbortSignal
  redirect?: RequestInit['redirect']
  action: 'exclude_from_refresh' | 'unhealthy_probe'
  trace?: UpstreamDiagnosticTrace
  requestId?: string
}

// 两个健康检查入口共享原有的 2xx + 精确 ok 判断，并保留每个上游失败的原因。
export async function checkUpstreamHealth(
  url: string,
  options: HealthProbeOptions,
): Promise<boolean> {
  const startedAt = Date.now()
  let response: Response | undefined
  try {
    response = await fetch(url, {
      signal: options.signal,
      redirect: options.redirect,
    })
    const body = response.ok ? await response.text() : undefined
    if (response.ok && body === 'ok') return true

    // 已读的健康正文传给诊断，避免读取两次。
    await reportUpstreamIssue({
      ...options,
      url,
      response,
      body,
      stage: 'health',
      method: 'GET',
      reason: response.ok ? 'invalid_health_body' : 'http_error',
      durationMs: Date.now() - startedAt,
    })
    await cancelResponseBody(response)
    return false
  } catch (error) {
    const failure = safeDiagnosticError(error, options.signal)
    if (failure.failureKind !== 'aborted') {
      await reportUpstreamIssue({
        ...options,
        url,
        response,
        stage: 'health',
        method: 'GET',
        reason: failure.failureKind,
        error,
        durationMs: Date.now() - startedAt,
      })
    }
    if (response) await cancelResponseBody(response)
    return false
  }
}
