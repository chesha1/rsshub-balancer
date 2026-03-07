import { trimSlash } from './utils'

export const config = {
  upstreams: [
    'https://hub.slarker.me',
    'https://rsshub.pseudoyu.com',
    'https://rsshub.ktachibana.party',
    'https://rsshub.umzzz.com',
    'https://rsshub.isrss.com',
    'https://rsshub.cups.moe',
    'https://rsshub.99010101.xyz',
  ].map(trimSlash),
  /** 上游失败记录在 KV 中的过期时间（秒） */
  failTtl: 600,
}
