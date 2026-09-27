export type RouteRequestMetric = {
  country: string
  // 成功请求记录返回响应的实例 URL，所有失败请求统一记录 failed。
  upstream: string
  path: string
}

export const METRICS_MAX_BATCH_SIZE = 200
