import { trimSlash } from './utils'

export const config = {
  fallbackUpstreams: ['https://rsshub.99010101.xyz'].map(trimSlash),
  /** 上游失败记录在 KV 中的过期时间（秒） */
  failTtl: 600,
}
