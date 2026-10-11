# 上游 Challenge 页面被误判为有效响应

记录日期：2026 年 10 月 12 日，时间均为北京时间。当前先在代码中排除相关实例，通用响应判定问题留待后续处理。

`rsshub.cups.moe` 返回 HTTP 200 的 HTML 验证页，负载均衡器却将其当成缓存命中和成功 Feed，停止尝试其他上游。问题在于把 HTTP 成功误当作业务数据有效。

## 已确认的证据

00:06 从 Oracle 的 Origin 容器直连该实例，以下接口均返回 HTTP 200、`text/html`，页面标题为 `Security Verification`：

- `/healthz`
- `/api/route/status?requestPath=%2Fopenai%2Fnews`
- `/openai/news`
- `/test/1`

页面要求浏览器执行 JavaScript 完成工作量证明后跳转。本轮响应没有 HTTP 3xx，也没有 `cf-mitigated: challenge` 头，不能仅凭其经过 Cloudflare 就认定为 Cloudflare 原生 Challenge。同轮自建上游的 `/openai/news` 约 5.6 秒返回 200 XML，仍有可用数据源。

## 误判机制

[上游选择逻辑](../packages/server-core/src/upstream.ts) 有两处只按状态码判断成功：

1. 缓存状态接口返回 200，就认为缓存命中，优先选择该实例；未验证响应是否为有效 JSON。
2. 转发取得 200 HTML 后直接返回，不尝试后续上游、不写失败标记，并记作成功结果。

[Watchdog](../apps/watchdog/src/probe.ts) 会检查 Content-Type 和 RSS 正文，因此正确拒绝该页面。代理认为成功、业务探针判定失败的冲突可能触发接管或阻止恢复。

隔离实验已确认，直接 200 HTML 和同源重定向后的 200 HTML 都会停止回退。普通 HTTP 重定向已有跟随逻辑；服务端 fetch 不会执行验证页中的 JavaScript，仅调整重定向选项不能解决这个问题。

## 临时处理

按用户要求，在 Origin 和 Edge 共用的候选过滤逻辑中排除 `rsshub.cups.moe`，覆盖远程列表、定时合并和 Redis 旧快照读取，避免该实例重新进入候选。

当前为本地代码调整，需分别发布 Origin 和 Edge 后在线上生效。通用响应判定、失败缓存和重试策略暂不调整。

## 待后续评估

- 缓存状态接口如何校验 JSON 及实际缓存状态。
- 如何按请求的预期格式识别验证页，并继续尝试其他上游，同时兼顾合法的非 RSS 输出。
- 补充异常响应的诊断日志和回归验证；不能只依赖 `cf-mitigated` 响应头识别 Challenge。
- 完成通用处理后，再决定是否重新允许该实例。
