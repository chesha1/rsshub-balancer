const trimSlash = (url: string) => url.replace(/\/+$/, '')

export const config = {
  upstreams: [
    'https://hub.slarker.me',
    'https://rsshub.pseudoyu.com',
    'https://rsshub.ktachibana.party',
    'https://rsshub.umzzz.com',
    'https://rsshub.isrss.com',
    'https://rsshub.cups.moe',
    'https://rsshub.umzzz.com',
    'https://rsshub.99010101.xyz',

  ].map(trimSlash),
  // 所有 upstream 均不可用时的兜底实例
  fallbackUpstream: trimSlash('https://rsshub.99010101.xyz'),
}
