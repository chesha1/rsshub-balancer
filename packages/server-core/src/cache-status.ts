import { cancelResponseBody } from './utils'

const JSON_CONTENT_TYPE =
  /^application\/(?:json|[a-z0-9][a-z0-9!#$&^_.+-]*\+json)$/i

type CacheStatus = { cached: true; lastBuildDate: string | null }

// RSSHub 缓存状态是短 JSON；直接读取并校验命中字段，额外字段不向外返回。
export async function readCacheStatus(
  response: Response,
): Promise<CacheStatus | undefined> {
  const contentType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    .trim()
  if (response.status !== 200 || !JSON_CONTENT_TYPE.test(contentType ?? '')) {
    await cancelResponseBody(response)
    return undefined
  }

  try {
    const value: unknown = await response.json()
    if (
      typeof value !== 'object' ||
      value === null ||
      !('cached' in value) ||
      value.cached !== true ||
      !('lastBuildDate' in value) ||
      (typeof value.lastBuildDate !== 'string' && value.lastBuildDate !== null)
    ) {
      return undefined
    }
    return { cached: true, lastBuildDate: value.lastBuildDate }
  } catch {
    // 解析、流读取和超时都只表示缓存尚未确认，实例仍可参与实际转发。
    return undefined
  }
}
