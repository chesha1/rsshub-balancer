# 上游异常日志与回看

Origin 与 Edge 默认记录所有候选上游的异常，沿用当前基本响应检查，不增加严格 XML 校验、自动解题或新的选路规则。日志走现有 JSON Lines 输出：Origin 用 Docker 日志查看，Edge 用 Workers Logs 查看。

## 记录范围

| 阶段 | 记录的情况 | 原有处理 |
| --- | --- | --- |
| `health` | 非成功状态、正文不是精确 `ok`、连接失败或超时 | 当前探测不健康；刷新时不纳入新候选列表 |
| `cache` | 异常状态或类型、无效 JSON/字段、连接失败或超时 | 只表示未确认缓存，不写业务失败标记，仍可尝试 Feed |
| `feed` | 明确 Challenge、成功状态的 HTML、普通 HTTP 错误、连接失败、超时、拒绝的重定向 | 使用原 TTL 标记失败并尝试下一上游 |

正常 `404 JSON` 缓存未命中、合法的 `cached:false`、聚合已获胜后的主动取消不告警。`404 HTML` 仍会留下缓存接口诊断，可能是验证页、登录页或不支持该 API，不能据此判定该实例的 Feed 不可用。

新增事件为 `upstream.response_rejected`（有响应）和 `upstream.request_failed`（未取得响应）。每条记录包括：

- `runtime`、`stage`、`reason`、`action`，以及去掉用户信息、查询和片段的目标及最终响应 URL。
- `requestId`；定时刷新使用本轮刷新 ID。外部请求的 ID 同时通过 `X-Request-Id` 响应头返回。
- 状态码、媒体类型、`cfMitigated`、`cfRay`、`server`、`retryAfter`、去掉查询参数的跳转地址。
- 固定的网络错误分类，例如 `timeout`、`network`、`redirect_cross_origin`；安全的 `errorName`、`errorCode`，不打印原始错误消息或堆栈。
- HTML 页面的短 `title` 和 `challengeSignals`，以及 `prefixState`、`prefixBytes`、`prefixTruncated`、`prefixError`。

## 识别验证现象

Cloudflare 原生 Challenge 的明确标记是 `cf-mitigated: challenge`，日志会显示 `reason=challenge_header` 和 `challengeSignals=["cf_mitigated", ...]`，同时保留 Ray ID。仅有 `server=cloudflare` 不代表一定是 Cloudflare 原生验证。[官方说明](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)

没有明确响应头时，仍记录意外 HTML。`proof_of_work`、`cloudflare_script`、`captcha`、`javascript_required`、`security_verification` 只是页面前缀中观察到的线索，不是对产品或触发原因的确定归因。例如 cups 页面可留下 `title=Security Verification` 和 `proof_of_work`，无需先在浏览器中打开才能发现。

读取仅发生在本来已经拒绝的 HTML 或明确挑战响应：最多取前 **8 KiB**，最多等待 **200 ms**，并服从原请求截止时间。正常 Feed 不读正文、不克隆；日志只输出标题和特征，不打印整页、正文片段、Cookie、Authorization、挑战参数或 URL 查询值。请求上下文保留 pathname、最多 16 个查询参数名及常用的 `format` 枚举值。

正文已消费或流不可读时，日志会标记 `prefixState=unavailable`。未捕获到特征不证明没有验证页，前缀可能截断、超时，或响应伪装成其它媒体类型。

## 关联处理结果

对于实际记录了异常的 Feed 请求，最终 `upstream.fetch` 成功摘要也输出为 warning，保留相同 Request ID、最终上游和尝试次数。全部失败仍记录 `all_failed`，失败标记命中仍记录 `all_marked_failed`。

公共健康和缓存接口分别用 `upstream.health_result`、`upstream.cache_status_result` 关联最终结果。聚合先得到赢家、随后才写出异常日志时，会补写一次结果摘要；不会为了日志等待所有探测。定时刷新使用相同刷新 ID 的 `cron.refresh`，可看最终增加或移除了哪些实例。

同一运行实例内，按“上游来源 + 阶段 + 原因 + 状态/错误码”**60 秒最多记录一次**，最多维护 256 个槽位；限频发生在读取正文之前。下一条日志的 `suppressedSinceLastLog` 表示期间抑制的次数。重启、不同 Worker isolate、平台采样、轮转及没有下一条日志的窗口都会影响覆盖，所以这不是完整流量计数。

## 回看命令

在仓库目录执行，读取 Origin 现有日志并按上游、阶段、原因汇总：

```bash
ssh -F ~/.ssh/config oracle \
  'docker logs --since 24h --timestamps rsshub-balancer-rsshub-balancer-1 2>&1' \
  | pnpm --silent logs:upstream
```

定位一个具体请求（将示例 ID 替换为真实 ID）：

```bash
ssh -F ~/.ssh/config oracle \
  'docker logs --since 24h rsshub-balancer-rsshub-balancer-1 2>&1' \
  | pnpm --silent logs:upstream --request-id REQUEST_ID
```

[回看工具](../scripts/upstream-log-summary.mjs) 流式处理 JSONL，也兼容 Docker 时间戳和旧日志。概览最多保留 512 个分组并展示其中前 50 项；按 ID 查询保留最后 50 条匹配事件。超限、非 JSON 和未识别记录会计数。旧日志缺少标题、CF 字段或阶段时不会补造这些信息；没有关联到最终摘要，也不能直接推断请求失败。

需要反复分析或即将重建容器时，先保存一份日志快照，再重复查询：

```bash
mkdir -p .diagnostics
umask 077
ssh -F ~/.ssh/config oracle \
  'docker logs --since 24h rsshub-balancer-rsshub-balancer-1 2>&1' \
  > .diagnostics/upstream-snapshot.jsonl
pnpm --silent logs:upstream < .diagnostics/upstream-snapshot.jsonl
```

`.diagnostics/` 不纳入 Git。Docker 日志保留仍由现有轮转策略决定，容器重建可能删除旧日志，不承诺固定天数；回看时应明确时间范围。Edge 在 Workers Logs 中按事件或 Request ID 查找；若导出平台外层包装，需要先提取应用 JSON 行再交给本工具。

## 公开仓库与私有日志

回看工具只读取 stdin 并把摘要写到终端，不连接服务器、不上传数据，也不提供公开日志接口；上面的 SSH 命令仍依赖本机配置和凭据。`.diagnostics/` 同时被 Git 和 Docker 构建忽略，快照和原始样本不要移入受版本管理的目录或作为公开 CI 产物上传。

脱敏用于减少日志中的敏感内容，不代表输出可以直接公开。请求路径可能包含账号或私有订阅标识，参数名和请求 ID 可由客户端提供，页面标题也可能带有上游回显的信息。旧日志及其它模块的日志不受新增诊断字段的全部限制；回看摘要仍应按私有运维材料处理，对外贴出前单独检查。

## 应用日志之外的边界

这里记录的是应用访问上游时看到的情况。如果请求被本站入口的 Cloudflare WAF/Challenge 挡在应用之前，应用本身没有收到它，需要按时间、URL 或 Ray ID 查 [Cloudflare Security Events](https://developers.cloudflare.com/waf/analytics/security-events/)。Cloudflare 缓存直接返回的请求也不经过这套应用日志。

后续排查先看异常汇总和同 ID 的最终结果，再对有问题的上游做少量针对性请求；需要完整挑战脚本时另做有界的一次性取证，长期日志只保留上述摘要。
