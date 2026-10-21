# 上游响应校验

Origin 和 Edge 共用响应校验逻辑，避免把 HTTP 成功的验证页当成缓存命中或有效 Feed。所有候选实例使用相同规则，不按域名单独处理。

## 缓存状态

内部选路和对外 `/api/route/status` 共用 [readCacheStatus()](../packages/server-core/src/cache-status.ts)。只有 HTTP 200、JSON Content-Type，且正文对象满足 `cached === true`、`lastBuildDate` 为字符串或 `null`，才确认命中；允许额外字段。

依赖 RSSHub 缓存状态是短 JSON 的业务约定，直接使用 `response.json()`。读取沿用请求的超时：内部探测 1 秒，对外聚合 5 秒。无效响应和超时都只表示未确认缓存，不写业务失败标记，实例仍可参与 Feed 转发。

对外聚合在确认命中后取消其余探测，只返回 `cached` 和 `lastBuildDate`。没有确认命中时返回 404 和 `{ cached: false, lastBuildDate: null }`，不代表所有上游确实没有缓存。

## Feed 响应

[上游转发](../packages/server-core/src/upstream.ts) 按以下顺序判断，使用代理清理逐跳头之前的原始响应头：

| 响应 | 处理 |
| --- | --- |
| `cf-mitigated: challenge`，包括非 2xx 和重定向 | 拒绝，不继续跟随，原因 `challenge_header` |
| 最终响应原本可成功转发，但类型为 `text/html` 或 `application/xhtml+xml` | 拒绝，原因 `unexpected_html` |
| 其余 200–399 最终响应 | 流式转发 |
| 其他 HTTP 错误、连接失败、超时或重定向错误 | 按普通失败回退 |

Content-Type 忽略大小写和参数。204、205、304 跳过 HTML 判断，但仍拒绝明确 Challenge；HEAD 只检查响应头，缺少 Content-Type 不单独判失败。同源跳转规则见 [上游重定向](upstream-redirects.md)。

拒绝后取消正文并尝试下一个候选。通用异常日志覆盖健康检查、缓存探测和 Feed，记录请求 ID、上游、状态码、媒体类型、CF 标记、原因和处理动作；已拒绝的 HTML 可限时读取少量前缀提取标题与验证特征，不打印正文或凭据。同类日志限频，已记录异常的请求会保留最终处理摘要，详见[上游异常日志与回看](upstream-observability.md)。

内容异常使用 300 秒失败标记，其他失败使用 21600 秒；每次失败只写一次，命中已有标记时跳过且不续期。全部候选不可用时返回 502。两类失败复用现有 key，粒度与并发写入语义见 [Redis 约定](redis.md)。

## 能力边界

正常 RSS、Atom、JSON、纯文本和空 Feed 均直接转发，不解析 Feed 正文或要求条目数量。合法 HTML 调试页也会被拒绝；没有明确标记且伪装成其他类型的验证页无法通过响应头识别。入口不执行 JavaScript 或 PoW，遇到不支持的验证时回退。

## cups 验证实验结论（2026-10-21）

当时捕获的验证页使用 `FNV-1a` 的无符号 32 位哈希计算 `seed + ":" + nonce`，`nonce` 为 base36 计数器，难度 4 要求八位十六进制结果前四位为零；通过 GET 参数 `kgl_pow_challenge` 和 `kgl_pow_nonce` 提交答案。它是已观察到的 PoW 协议，不能仅凭页面经过 Cloudflare 就认定是 Cloudflare 原生 Challenge。

同一 Origin 出口、同一 User-Agent 下，独立实验确认：无 Cookie 请求返回验证页，提交答案后收到 302 和 `kgl_cookie`，携带 Cookie 取得 `/test/1` RSS，再次请求原 URL 仍取得相同正文；无 Cookie 对照再次返回验证页。计算耗时约 2.41 ms，含线程启动约 21.43 ms。Cookie 声明 `Max-Age=60`、仅当前主机、`Path=/`、`Secure`、`HttpOnly`、`SameSite=Lax`；跨 UA、路径、出口及过期行为未验证。

该实验只证明当时的协议和短期会话可用，未接入生产自动求解。实验对 RSS 做了基本结构检查，另一次取样通过标准 XML 解析，但后者不是对原响应的重新验证。临时探针、求解器、原始留样代码和部署产物已清理，Origin 已恢复原镜像；私有证据留在 Git 忽略的 `.diagnostics/`，日常排查使用上面的通用日志。
