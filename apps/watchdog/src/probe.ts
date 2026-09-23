import { XMLParser } from 'fast-xml-parser'
import {
  APP_HEADER,
  FailoverError,
  FEED_PATHS,
  HEALTH_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
} from './config'

type ProbeResult = {
  app: string | null
  healthy: boolean
}

type FeedItem = {
  title?: unknown
  link?: unknown
}

// 健康接口只读取状态码和应用标识；业务是否可用由后续 Feed 请求确认。
async function probeHealth(
  host: string,
  signal: AbortSignal,
): Promise<ProbeResult> {
  let response: Response
  try {
    response = await fetch(`https://${host}/healthz`, {
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(HEALTH_TIMEOUT_MS)]),
    })
  } catch {
    signal.throwIfAborted()
    return { app: null, healthy: false }
  }

  try {
    // 认证失败和重定向通常是入口配置问题，不据此自动改变路由。
    if (response.status < 500 && response.status !== 200) {
      throw new FailoverError('unexpected_probe_status')
    }
    return {
      app: response.headers.get(APP_HEADER),
      healthy: response.status === 200,
    }
  } finally {
    try {
      await response.body?.cancel()
    } catch {
      // 连接可能已关闭，释放正文失败不影响已取得的状态码。
    }
  }
}

// 实际 GET 指定 RSS 路由，要求 XML 合法且至少有一篇带标题和链接的文章。
async function probeFeed(
  host: string,
  path: string,
  signal: AbortSignal,
): Promise<boolean> {
  const response = await fetch(`https://${host}${path}`, {
    // 与订阅客户端保持一致，跟随业务路由的重定向，包括跨域跳转。
    redirect: 'follow',
    cache: 'no-store',
    signal,
  })
  try {
    const contentType = response.headers
      .get('Content-Type')
      ?.split(';', 1)[0]
      .trim()
      .toLowerCase()
    if (
      response.status !== 200 ||
      !['application/rss+xml', 'application/xml', 'text/xml'].includes(
        contentType ?? '',
      )
    ) {
      return false
    }
    // 完整读取正文并严格按 UTF-8 解码，读取过程仍受本次探测的截止时间控制。
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(await response.arrayBuffer())
    signal.throwIfAborted()
    // 保留标题和链接的字符串，不展开自定义实体；开启 XML 校验以拒绝截断或损坏正文。
    const feed: { rss?: { channel?: { item?: FeedItem | FeedItem[] } } } =
      new XMLParser({ parseTagValue: false, processEntities: false }).parse(
        text,
        true,
      )
    const items = feed.rss?.channel?.item
    const entries = Array.isArray(items) ? items : [items]
    return entries.some(
      (item) =>
        typeof item?.title === 'string' &&
        item.title.trim().length > 0 &&
        typeof item.link === 'string' &&
        item.link.trim().length > 0,
    )
  } finally {
    try {
      await response.body?.cancel()
    } catch {
      // 网络中断或超时可能已关闭正文，不影响健康判定。
    }
  }
}

// 健康接口与全部业务探针共用截止时间，任一路由请求、正文或 XML 异常均判为不健康。
export async function probe(host: string): Promise<ProbeResult> {
  const requestSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  let result: ProbeResult = { app: null, healthy: false }
  try {
    result = await probeHealth(host, requestSignal)
    // 保留未知来源的健康状态，让主流程按原约定报配置错误，不能被 Feed 失败掩盖。
    if (!result.healthy || (result.app !== 'origin' && result.app !== 'edge')) {
      return result
    }
    // 并行探测避免等待时间随路由数累加；等待全部请求结束，失败时也不遗留后台请求。
    const feeds = await Promise.allSettled(
      FEED_PATHS.map((path) => probeFeed(host, path, requestSignal)),
    )
    return {
      app: result.app,
      healthy: feeds.every((feed) => feed.status === 'fulfilled' && feed.value),
    }
  } catch (error) {
    if (error instanceof FailoverError) throw error
    return { app: result.app, healthy: false }
  }
}
