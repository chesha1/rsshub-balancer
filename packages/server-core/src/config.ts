import { trimSlash } from './utils'

export const config = {
  fallbackUpstreams: ['https://rsshub.99010101.xyz'].map(trimSlash),
  /** instances 内存缓存有效期（秒），过期请求等待同一轮 Redis 读取。 */
  instancesRefreshIntervalSeconds: 600,
  /** 上游失败记录在状态存储中的过期时间（秒） */
  failTtl: 21600,
}
