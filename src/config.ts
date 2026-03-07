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
}
