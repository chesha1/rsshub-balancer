import {
  reportUpstreamIssue,
  safeDiagnosticError,
  type UpstreamDiagnosticTrace,
} from './upstream-observability'
import { cancelResponseBody } from './utils'

const JSON_CONTENT_TYPE =
  /^application\/(?:json|[a-z0-9][a-z0-9!#$&^_.+-]*\+json)$/i

type CacheStatus = { cached: true; lastBuildDate: string | null }

type CacheDiagnosticOptions = {
  signal?: AbortSignal
  trace?: UpstreamDiagnosticTrace
}

// 异常缓存响应只记录诊断，不更改选路资格或写入业务失败标记。
async function reportCacheIssue(
  response: Response,
  url: string,
  reason: string,
  options: CacheDiagnosticOptions,
  error?: unknown,
): Promise<void> {
  await reportUpstreamIssue({
    response,
    url,
    stage: 'cache',
    method: 'GET',
    action: 'ignore_cache_hint',
    reason,
    error,
    ...options,
  })
}

// RSSHub 缓存状态是短 JSON；直接读取并校验命中字段，额外字段不向外返回。
export async function readCacheStatus(
  response: Response,
  url = response.url,
  options: CacheDiagnosticOptions = {},
): Promise<CacheStatus | undefined> {
  const contentType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    .trim()
  if (response.status !== 200 || !JSON_CONTENT_TYPE.test(contentType ?? '')) {
    // 404 JSON 是正常的未命中；HTML、其它状态或类型才需要异常记录。
    if (
      response.status !== 404 ||
      !JSON_CONTENT_TYPE.test(contentType ?? '') ||
      response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge'
    ) {
      await reportCacheIssue(
        response,
        url,
        response.status === 200
          ? 'unexpected_cache_content_type'
          : 'http_error',
        options,
      )
    }
    await cancelResponseBody(response)
    return undefined
  }

  try {
    const value: unknown = await response.json()
    if (
      typeof value !== 'object' ||
      value === null ||
      !('cached' in value) ||
      (value.cached !== true && value.cached !== false) ||
      !('lastBuildDate' in value) ||
      (typeof value.lastBuildDate !== 'string' && value.lastBuildDate !== null)
    ) {
      await reportCacheIssue(response, url, 'invalid_cache_payload', options)
      return undefined
    }
    // 合法 cached:false 仍是普通未命中，不作为异常刷日志。
    if (!value.cached) return undefined
    return { cached: true, lastBuildDate: value.lastBuildDate }
  } catch (error) {
    // 解析、流读取和超时都只表示缓存尚未确认，实例仍可参与实际转发。
    const failure = safeDiagnosticError(error, options.signal)
    if (failure.failureKind !== 'aborted') {
      await reportCacheIssue(
        response,
        url,
        failure.failureKind === 'timeout' ? 'timeout' : 'invalid_cache_json',
        options,
        error,
      )
    }
    return undefined
  }
}
