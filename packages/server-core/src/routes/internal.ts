import { type Context, Hono } from 'hono'
import { errorProps, httpLogger } from '../log'
import * as upstream from '../upstream'

type TrafficSankeyRow = {
  country: string
  upstream: string
  value: number
}

type TrafficSankeySqlRow = {
  country: string
  upstream: string
  request_total: number
}

const TRAFFIC_SANKEY_WINDOW_HOURS = 24

const TRAFFIC_SANKEY_QUERY = `
SELECT
  blob1 AS country,
  blob2 AS upstream,
  sum(_sample_interval) AS request_total
FROM rsshub_balancer_request_flows
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY country, upstream
ORDER BY request_total DESC
FORMAT JSON
`

// 将查询得到的请求数映射为首页图表的连线权重。
function parseTrafficSankeyRows(payload: {
  data: TrafficSankeySqlRow[]
}): TrafficSankeyRow[] {
  return payload.data.map((row) => ({
    country: row.country,
    upstream: row.upstream,
    value: row.request_total,
  }))
}

// 从公开 UI 数据命名空间返回当前上游列表，响应中不暴露状态存储错误细节。
async function handleInternalUpstreams(c: Context) {
  if (c.req.method !== 'GET') {
    return c.text('Method Not Allowed', 405, {
      Allow: 'GET',
    })
  }

  const url = new URL(c.req.url)
  if (url.search !== '') {
    return c.json({ error: 'bad_request' }, 400)
  }

  try {
    const upstreams = await upstream.getUpstreams()
    return c.json({ upstreams })
  } catch (e) {
    httpLogger.warn('public upstream list request failed', {
      event: 'internal.upstreams',
      outcome: 'failed',
      ...errorProps(e),
    })
    return c.json({ error: 'internal_error' }, 500)
  }
}

// 查询最近 24 小时国家到上游的请求数量，供首页桑基图展示。
async function handleTrafficSankey(c: Context) {
  if (c.req.method !== 'GET') {
    return c.text('Method Not Allowed', 405, {
      Allow: 'GET',
    })
  }

  const url = new URL(c.req.url)
  if (url.search !== '') {
    return c.json({ error: 'bad_request' }, 400)
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const analyticsApiToken = process.env.CLOUDFLARE_ANALYTICS_API_TOKEN?.trim()
  if (!accountId || !analyticsApiToken) {
    httpLogger.warn('analytics sankey request missing required secrets', {
      event: 'internal.metrics.country_colo_sankey',
      outcome: 'missing_secret',
      hasAccountId: Boolean(accountId),
      hasAnalyticsApiToken: Boolean(analyticsApiToken),
    })
    return c.json({ error: 'internal_error' }, 500)
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${analyticsApiToken}`,
          'Content-Type': 'text/plain;charset=UTF-8',
        },
        body: TRAFFIC_SANKEY_QUERY,
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!response.ok) {
      throw new Error(`analytics query failed: ${response.status}`)
    }

    const payload = (await response.json()) as {
      data: TrafficSankeySqlRow[]
    }
    return c.json({
      rows: parseTrafficSankeyRows(payload),
      generatedAt: new Date().toISOString(),
      windowHours: TRAFFIC_SANKEY_WINDOW_HOURS,
    })
  } catch (e) {
    httpLogger.warn('analytics sankey request failed', {
      event: 'internal.metrics.country_colo_sankey',
      outcome: 'failed',
      ...errorProps(e),
    })
    return c.json({ error: 'internal_error' }, 500)
  }
}

// 列表查询直接使用上游模块，与代理和当前进程或 isolate 的定时刷新共用缓存。
export const internalRoutes = new Hono()
internalRoutes.all('/upstreams', handleInternalUpstreams)
internalRoutes.all('/metrics/country-colo-sankey', handleTrafficSankey)
