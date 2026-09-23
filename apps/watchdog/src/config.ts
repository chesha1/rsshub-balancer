export const HOST = 'rsshub-balancer.virworks.moe'
export const NODE_HOST = 'rsshub-balancer-origin.virworks.moe'
export const WORKER_NAME = 'rsshub-balancer'
export const CATCH_ALL = `${HOST}/*`
export const APP_HEADER = 'X-RSSHub-App'
// 业务探针全部通过才算健康；新增探针只需向列表追加路由。
export const FEED_PATHS = ['/openai/news', '/github/issue/DIYgod/RSSHub']

// 每次完整探测最多等待 30 秒，包含健康接口与所有业务 Feed 的完整正文读取。
export const PROBE_TIMEOUT_MS = 30_000
// 健康接口只确认应用来源和上游聚合状态，最多等待 15 秒。
export const HEALTH_TIMEOUT_MS = 15_000
// 同轮连续两次确认故障或恢复，避免一次短暂抖动就触发切换。
export const PROBE_ATTEMPTS = 2
// 每次 Routes 操作用独立 AbortSignal 限时 3 秒，覆盖响应头与正文读取。
export const API_TIMEOUT_MS = 3_000
// 同一轮内，两次探活之间等待 10 秒，过滤短暂故障和短暂恢复。
export const RETRY_DELAY_MS = 10_000

// 只把本地定义的错误代码写入日志，避免外部错误正文或凭证进入日志。
export class FailoverError extends Error {}
