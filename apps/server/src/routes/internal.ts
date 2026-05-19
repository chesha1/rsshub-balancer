import { Hono } from 'hono'
import { errorProps, httpLogger } from '../log'
import { createStateStore } from '../store'
import type { AppContext, AppEnv, RouteRequestOutcome } from '../types'
import { getUpstreams } from '../upstream'

type CountryColoSankeyRow = {
  country: string
  edgeColo: string
  outcome: RouteRequestOutcome
  upstream: string
  value: number
}

type CountryColoSankeySqlRow = {
  country: string
  edge_colo: string
  outcome: RouteRequestOutcome
  upstream: string
  request_total: number
}

const TRAFFIC_SANKEY_WINDOW_HOURS = 24

const COUNTRY_COLO_SANKEY_QUERY = `
SELECT
  blob8 AS country,
  blob9 AS edge_colo,
  blob5 AS outcome,
  if(
    blob5 = 'direct_upstream' AND blob7 != '' AND blob7 != 'none',
    blob7,
    'not_recorded'
  ) AS upstream,
  sum(_sample_interval * double1) AS request_total
FROM rsshub_balancer_metrics
WHERE timestamp > NOW() - INTERVAL '1' DAY
  AND blob1 = 'route_request'
  AND blob5 IN (
    'direct_upstream',
    'isolate_coalesced',
    'do_coalesced'
  )
GROUP BY country, edge_colo, outcome, upstream
ORDER BY request_total DESC
FORMAT JSON
`

const internalRoutes = new Hono<AppEnv>()

// 将 SQL API 的列名转换成前端约定的 camelCase 字段。
function parseCountryColoSankeyRows(payload: {
  data: CountryColoSankeySqlRow[]
}): CountryColoSankeyRow[] {
  return payload.data.map((row) => ({
    country: row.country,
    edgeColo: row.edge_colo,
    outcome: row.outcome,
    upstream: row.upstream,
    value: row.request_total,
  }))
}

// 从公开 UI 数据命名空间返回当前上游列表，响应中不暴露状态存储错误细节。
export async function handleInternalUpstreams(c: AppContext) {
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
    const upstreams = await getUpstreams(createStateStore(c.env), {
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    })
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

// 查询最近 24 小时来源、入口机房、处理结果和真实上游的聚合分布，供首页桑基图展示。
export async function handleCountryColoSankey(c: AppContext) {
  if (c.req.method !== 'GET') {
    return c.text('Method Not Allowed', 405, {
      Allow: 'GET',
    })
  }

  const url = new URL(c.req.url)
  if (url.search !== '') {
    return c.json({ error: 'bad_request' }, 400)
  }

  const accountId = c.env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const analyticsApiToken = c.env.CLOUDFLARE_ANALYTICS_API_TOKEN?.trim()
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
        body: COUNTRY_COLO_SANKEY_QUERY,
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!response.ok) {
      throw new Error(`analytics query failed: ${response.status}`)
    }

    const payload = (await response.json()) as {
      data: CountryColoSankeySqlRow[]
    }
    return c.json({
      rows: parseCountryColoSankeyRows(payload),
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

internalRoutes.all('/upstreams', handleInternalUpstreams)
internalRoutes.all('/metrics/country-colo-sankey', handleCountryColoSankey)

export default internalRoutes
