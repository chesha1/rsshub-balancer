import { trimSlash } from './utils'

export const config = {
  fallbackUpstreams: ['https://rsshub.99010101.xyz'].map(trimSlash),
  /** 公开 RSS 响应的 Workers Cache 策略：新鲜 5 分钟，后台刷新与失败兜底各保留 1 小时。 */
  publicProxyCacheControl:
    'public, max-age=300, stale-while-revalidate=3600, stale-if-error=3600',
  /** instances 内存缓存后台刷新间隔（秒），有缓存时请求热路径不阻塞读状态存储。 */
  instancesRefreshIntervalSeconds: 600,
  /** 上游失败记录在状态存储中的过期时间（秒） */
  failTtl: 21600,
}
