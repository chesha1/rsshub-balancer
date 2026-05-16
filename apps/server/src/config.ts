import { trimSlash } from './utils'

export const config = {
  fallbackUpstreams: ['https://rsshub.99010101.xyz'].map(trimSlash),
  /** instances 内存缓存后台刷新间隔（秒），有缓存时请求热路径不阻塞读状态存储。 */
  instancesRefreshIntervalSeconds: 600,
  /** 上游失败记录在状态存储中的过期时间（秒） */
  failTtl: 600,
}
