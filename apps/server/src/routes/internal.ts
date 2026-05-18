import { errorProps, httpLogger } from '../log'
import { createStateStore } from '../store'
import type { AppContext } from '../types'
import { getUpstreams } from '../upstream'

type CountryColoSankeyLink = {
  source: string
  target: string
  value: number
}

const TRAFFIC_SANKEY_WINDOW_HOURS = 24

const COUNTRY_COLO_SANKEY_QUERY = `
SELECT
  if(blob8 = '', 'unknown', blob8) AS country,
  if(blob9 = '', 'unknown', blob9) AS edge_colo,
  sum(_sample_interval * double1) AS request_total
FROM rsshub_balancer_metrics
WHERE timestamp > NOW() - INTERVAL '1' DAY
  AND blob1 = 'route_request'
GROUP BY country, edge_colo
ORDER BY request_total DESC
FORMAT JSON
`

// 判断未知 JSON 值是否是普通对象，供 Analytics Engine 响应解析复用。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// 将 Analytics Engine 维度值统一规整为可展示的非空字符串。
function normalizeMetricDimension(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : 'unknown'
}

// 将 Analytics Engine 聚合计数转成桑基图可用的有限非负数。
function normalizeMetricCount(value: unknown): number {
  const normalized = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error('analytics row count invalid')
  }

  return normalized
}

// 从 Analytics Engine SQL API 响应中提取 country -> edge colo 的桑基图 link。
function parseCountryColoSankeyLinks(
  payload: unknown,
): CountryColoSankeyLink[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('analytics response shape invalid')
  }

  return payload.data.map((row) => {
    if (!isRecord(row)) {
      throw new Error('analytics row shape invalid')
    }

    return {
      source: normalizeMetricDimension(row.country),
      target: normalizeMetricDimension(row.edge_colo),
      value: normalizeMetricCount(row.request_total),
    }
  })
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

// 查询最近 24 小时来源国家/地区到入口机房的聚合分布，供首页桑基图展示。
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

    const payload = await response.json()
    return c.json({
      links: parseCountryColoSankeyLinks(payload),
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
