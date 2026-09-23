# 迁移、发布与故障接管

本手册执行[总方案](./README.md)。首次迁移及线上验收已完成，2026-09-23 用户确认服务在线上运行良好，已通过各类 Dashboard 检查；不再追加迁移专项验收或独立恢复演练。独立探活 Worker 已实现自动接管和恢复，部署与启用按下文执行；维护用的手动接管／恢复 Actions 尚待实现。

## 首次迁移

首次迁移已完成。以下保留操作顺序供后续参考，准备期间保留原入口服务。

1. **保存现场**：读取线上 Routes、独立的 Custom Domains 列表、DNS、缓存/重定向规则及 `my-servers` 有效配置，备份受影响配置与可回滚版本。
2. **准备 Worker**：完成共享运行时、独立 Redis 状态、ingest、查询和前端适配，验证原有 RSS 后端仍可接管。
3. **准备 Node**：完成容器、Traefik、TLS、配置及初始化；通过固定云下入口 `https://rsshub-balancer-origin.virworks.moe` 验证 Node 的 `/healthz`、Feed GET/HEAD 和业务查询；异常时再用 Oracle 本机入口区分后端与公网回源问题。经 Traefik 验证时保留正确 Host。
4. **切到 Node**：建立[三条长期 Routes](./README.md#路由)，清理旧规则，完成 DNS/Custom Domain 转换，确认 origin 已从旧的直接 RSSHub 改为 Node balancer，配置首页重定向和缓存规则，最后删除 catch-all。
5. **公开验收**：按下文清单读回配置、验证执行位置；失败则恢复 catch-all 并核对。跨 DNS/Custom Domain 的转换失败时，按现场备份恢复受影响资源。
6. **次日观察指标**：按用户决定，真实 Node 指标不作为首次切流前置验收；Node 承接流量运行一天后，由用户通过首页桑基图查看统计。

存在 Custom Domain 时，先备好 zone Route、反代和证书，再移除绑定并立即核对 DNS；若记录被一并删除，补建橙云记录。转换期间保留指向原 Worker 的 catch-all，准备完成后再删；这些操作不是原子的。

## 接管与恢复

独立探活 Worker 启用后自动接管和恢复。人工当前通过 Dashboard/API 接管或恢复，后续封装为维护用的 Actions flow；需要保持人工选择的承接环境时，先停用 watchdog 并确认在途执行结束。自动与手动切换共用以下约定。

- **接管**：重新读取 Routes，创建或确认 `rsshub-balancer.virworks.moe/* -> rsshub-balancer`，读回 pattern/script。watchdog 在主域名连续两次业务检查失败后执行，读回确认即结束本轮；手动发布时还需验证公开请求到达 Worker，确认前保留旧 Node。
- **恢复**：watchdog 通过固定云下入口连续两次确认健康接口与业务 Feed 均可用，再删除上述 catch-all，读回确认消失后结束本轮，下一轮检查主域名实际业务。手动发布时仍先检查版本、启动、Feed 和查询，并在回切后验证主域名；接管中的公开 `/healthz` 不能证明 Node 恢复。
- **异常**：约定 catch-all 指向其他脚本或 no-script 时停止并人工核对，不覆盖已有配置；其他路由由人工维护。API 超时先读回实际结果，无法核实就报错。watchdog 每轮最多发出一次创建或删除，不反向切换；恢复后的业务异常留到下一轮检查，满足故障条件后再接管。人工维护发现恢复失败时仍可手动重新接管，再排查 Node。

自动切换和手动 Actions flow 使用 API 时先列出完整 Routes，创建只针对约定 catch-all，删除 ID 必须来自本次列表且 pattern/script 精确匹配。检查 HTTP 状态和 JSON `success`，给 API 与公开检查设置有限超时；结果无法核实则报告未知，不记成功。[Routes API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/)

## 发布与回滚

应用代码和镜像构建留在本仓库；Compose、Traefik、TLS 和服务器部署配置放在同级 `my-servers`。GitHub Actions 构建并推送明确版本镜像，由操作者决定更新时间，真实密钥只在运行环境注入。

[Origin image 工作流](../../.github/workflows/origin-image.yml) 仅在向 `main` 推送 Node 相关变更后发布 `ghcr.io/chesha1/rsshub-balancer:sha-<完整提交 SHA>`，同时更新 `latest`；支持 amd64 和 arm64。触发范围和 GHCR 拉取权限见 [Origin 镜像 CI](../../README.md#origin-镜像-ci)。发布完成后从 Actions 摘要复制镜像 digest，在 `my-servers` 的部署配置中固定 `ghcr.io/chesha1/rsshub-balancer@sha256:...`，并记录旧 digest 用于回滚。不要依赖 `latest` 或可被重建覆盖的 SHA 标签锁定运行版本；本流水线不清理历史镜像。

日常发布顺序（切换 Actions 实现前通过 Dashboard/API 操作）：

1. 保留上一版 Worker、Node 镜像及配置，预先确认新镜像可拉取、备用 Worker 可用。
2. 停用 watchdog，确认最后一轮执行结束并读回 Routes；再手动接管并确认主域名到达 Worker。随后用 Compose 只更新 balancer，不停 Redis、Traefik 或备用端依赖的上游。watchdog 启用时会自动删除人工建立的接管 Route，不能用它保持发布期间的云上承接。
3. 直接检查新 Node 版本、启动日志、业务和指标；通过后重新部署 watchdog 并注入凭证，由它自动恢复，并在后续轮次检查主域名。也可以先手动恢复并验证，再重新启用 watchdog。

新版本失败时保持 Worker 接管，恢复旧 Node 镜像和配置后重验；不清空两端 Redis 状态，同一指标格式下保留已有数据。Compose 设置 `init: true`（直接运行镜像时使用 `docker run --init`），由轻量 init 作为 PID 1 转发 SIGTERM，Node 按默认行为终止。未启用 init 时，Node 直接作为 PID 1 可能忽略停止信号，直到容器超时强杀，见 [Node 镜像信号说明](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md#handling-kernel-signals)。应用不等待在途请求、刷新或指标上传，允许中断未完成请求并丢失未上传指标。`stop_grace_period` 是容器运行时强制终止前的等待上限，不对应应用内清理期限。

业务改动默认用同一源码配套构建、验证两端，适配层修复可在兼容时单侧发布。指标写入、查询结构和前端配套发布、回滚。当前国家、上游两字段格式使用新数据集 `rsshub_balancer_request_flows`，Worker 的 `METRICS` binding 与两端查询表名必须一致；若回滚指标格式，同步恢复匹配的数据集绑定与查询表名，避免同一数据集混用列映射。

## 后续变更检查

本次迁移验收已完成。以下清单供后续发布、配置变更或故障排查时按影响范围使用；协议和运行时边界按各主题文档核对，不作为当前迁移待办或独立演练要求。

| 范围 | 通过条件 |
| --- | --- |
| 流向与业务 | Route API 读回正确；确认 MISS 的 Feed 和各业务查询通过请求 ID 对应 Node/Traefik 或 Worker 日志，覆盖 GET/HEAD、405/404、响应头、压缩及流式响应 |
| 首页与固定接口 | 首页、静态资源及 ingest 始终可用，缺失静态文件 404；刷新首页后的上游列表来自当前运行时 |
| 运行时 | 配置与双目标构建、缓存刷新/失败标记、Redis 隔离/复用/断线/超时及默认信号终止通过；确认停止 Node 后 Redis 已有状态保留，核对可信 header、真实 IP 和反代来源限制 |
| 指标 | WAF 允许服务器公网出口 IP、阻断其他来源访问 ingest，且无绕过 WAF 的公开入口；国家、上游两列映射正常，两端统计口径一致；上传失败不影响 RSS；写入绑定和查询均指向 `rsshub_balancer_request_flows`，前端使用同一格式 |
| 缓存 | 通过[缓存验证](./zone-cache-plan.md#验证与回滚)，实时接口不返回旧诊断结果；需立即更新时只清理受影响 Feed |

日志级别须能留下实际验证证据，不能依赖默认未输出的 info 日志。API 读回与单点公开验证不代表全球同时完成传播；接管也只移动 balancer，Redis、fallback 和上游仍可能共享故障。

## 后续自动化

### 独立探活 Worker

代码位于 [apps/watchdog](../../apps/watchdog/)，部署名为 `rsshub-balancer-watchdog`。它只有每 3 分钟一次的 `scheduled()`（`*/3 * * * *`），没有公开 HTTP 入口，不依赖业务 Redis、共享后端或 DO。真正承接 RSS 的仍是现有 `rsshub-balancer` Worker。

启用后每轮执行：

1. 读取 Routes，只查找约定 catch-all，以是否存在决定本轮检查方向。指向其他脚本或 no-script 时停止并报错；其他路由由人工维护，watchdog 不检查整个 zone 的路由配置。
2. 没有 catch-all 时检查主域名 `https://rsshub-balancer.virworks.moe`，连续两次业务检查失败才接管，任意一次健康就结束。直接检查用户实际访问的入口，避免固定源站正常却漏掉主域名故障。
3. 已有 catch-all 时检查固定源站 `https://rsshub-balancer-origin.virworks.moe`，连续两次 `/healthz` 返回 `200 + origin` 且全部业务 Feed 正常才恢复，任意一次不健康就结束并保留接管。每次先 GET `/healthz`，最多等待 15 秒；健康且有已知应用标识时再并行 GET `FEED_PATHS` 中的全部路由并读取完整正文。健康接口与所有业务请求共用 30 秒截止时间，任一路由失败或超时都判为本次探测失败。两种方向都在两次探测之间等待 10 秒，计数不跨 Cron 保存。
4. 切换前重新读取 Routes：接管时若规则已存在，或恢复时规则已消失，直接结束；否则只 POST 一次，或按刚取得且 pattern/script 匹配的 ID DELETE 一次。无论请求成功、报错或超时，均读回确认实际结果；无法确认就报错，不追加写入。
5. 路由读回后结束本轮，不追加公开验证或反向切换。恢复后的主域名故障留给下一轮发现并接管；不提供跨轮稳定窗口或切换冷却期，持续波动仍可能在不同轮次间反复切换。

两端 `/healthz` 保留上游聚合语义、双 `no-store` 头和 `X-RSSHub-App: origin/edge`。固定源站必须来自 origin；主域名接受 origin 或 edge，允许路由传播期间仍由已知的 edge 提供健康业务。健康接口只读取状态码和应用标识，随后关闭正文；其 5xx 和网络失败计入失败，重定向、4xx、错误应用标识或 200 缺少应用标识仍按入口配置异常报错，不据此修改路由。该标识用于确认响应应用，不作为鉴权。

业务探针列表位于 [config.ts](../../apps/watchdog/src/config.ts) 的 `FEED_PATHS`，当前为 `/openai/news` 和 `/github/issue/DIYgod/RSSHub`；增加探针只需追加路由。业务探针通过 `fetch` 自动跟随重定向，包括跨域跳转，不额外限制目标域名；每条路由的最终响应都必须为 HTTP 200，Content-Type 为 `application/rss+xml`、`application/xml` 或 `text/xml`，完整正文是合法 XML，且 `rss.channel.item` 至少包含一篇非空标题、非空链接的文章。完整读取正文后使用 `fast-xml-parser` 校验和解析，不设置正文大小上限；最终非 200、错误内容类型、空 Feed、损坏 XML、重定向循环或读取超时均判为业务失败。探针只代表所选路由可用，不要求文章必须在近期发布。

所有探测请求均设置 `cache: no-store`，业务探测绕过 Cloudflare HTTP 缓存，应用与上游自身的 Feed 缓存仍按正常业务流程使用；无需给健康检查增加随机 query 或强制重新抓取上游内容。健康接口仍不跟随重定向；业务探针的重定向链与最终正文读取共用本次探测的 30 秒截止时间。

探活 Worker 单独启用 `global_fetch_strictly_public`，让同 zone 请求经过 Cloudflare 公网入口；主域名的验证不使用会绕过公开路由的 Service Binding。该配置不改变业务 Worker 的 fetch 行为。[公网 fetch 说明](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)

Routes API 每次最多 3 秒，检查 HTTP 状态和 JSON `success`；删除与创建共用 **Workers Routes Write** 权限。[删除接口](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/delete/)

每轮最多两次探测和一次路由修改，各次探测与 API 请求独立限时，不再设置整轮截止时间或回退预留。恢复后立即出现故障时，可能需要等待下一轮，再加上探测与路由传播时间，不保证三分钟内恢复。Cron、平台重试和人工操作可能交错，每轮一次修改及 API 读回均不提供互斥保证；需要保持人工选择时仍应先停用 watchdog。

无需切换时不输出业务日志；本轮创建接管并读回确认后记录 `takeover_route_created`，删除接管并读回确认后记录 `takeover_route_deleted`。两者只代表路由状态已确认，不代表切换后的业务已验证。创建或删除结果无法确认时分别报 `takeover_not_confirmed`、`recovery_not_confirmed`；其他异常同样由平台记录 Cron 执行失败。正常执行可查看平台的 [Cron 调用记录](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs)。日志不记录 token、外部错误正文或健康正文。

### 配置、部署与停用

watchdog 部署后即按每 3 分钟 Cron 执行自动接管和恢复，停用时删除 `rsshub-balancer-watchdog`，需要时重新部署。当前尚未部署，按以下顺序准备并启用：

1. 发布带应用标识的 origin 与 edge。通过固定源站入口确认 `/healthz` 的 `X-RSSHub-App: origin` 和 `FEED_PATHS` 中每条路由的 RSS 正文；无应用标识的旧版 200 会停止自动切换。
2. 在 [watchdog/wrangler.jsonc](../../apps/watchdog/wrangler.jsonc) 填写 `virworks.moe` 的 `CLOUDFLARE_ZONE_ID`。将 [.dev.vars.example](../../apps/watchdog/.dev.vars.example) 复制为同目录已忽略的 `.dev.vars`，填写只限该 zone 的 `CLOUDFLARE_ROUTES_API_TOKEN`；权限为 **Workers Routes Write**，也用于读取 Routes，不复用 Analytics 查询 token。[API 权限](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/create/)
3. 执行 `pnpm build:watchdog`。首次部署或删除后重新部署时，同时注入凭证：

   ```bash
   pnpm exec wrangler deploy --config apps/watchdog/wrangler.jsonc --secrets-file apps/watchdog/.dev.vars
   ```

4. 在 Cron 调用记录中确认任务正常执行；发生接管或异常时查看对应日志或错误码。后续更新使用 `pnpm deploy:watchdog`，会保留已有 secret；删除后重建需要再次使用上面的 `--secrets-file` 命令注入。发布凭证与 Worker 内的 Routes token 分别配置。[随代码上传 Secrets](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code)

停用时删除 watchdog：[Wrangler delete](https://developers.cloudflare.com/workers/wrangler/commands/workers/#delete)

```bash
pnpm exec wrangler delete --config apps/watchdog/wrangler.jsonc
```

删除 watchdog 不会删除业务 Worker `rsshub-balancer` 或指向它的接管 Route，也不撤销已发出的在途写入。人工维护前确认最后一轮已结束，并重新读回 Routes；不要把删除 watchdog 成功视为在途操作已停止。停用后若要恢复 Node，仍按[接管与恢复](#接管与恢复)操作，并读回最终 Routes 确认结果。

本地使用 `pnpm dev:watchdog`，访问 `http://127.0.0.1:8788/cdn-cgi/local/scheduled?cron=*/3+*+*+*+*` 模拟 Cron。模拟入口会执行完整的探测和双向切换逻辑，`--local` 不会隔离公网 fetch；配置生产 zone 和 Routes token 后触发它可能创建或删除线上路由。日常开发使用类型检查和 `pnpm build:watchdog` 的 dry-run 构建，切换流程验证应 mock 公网 fetch。修改 bindings 后运行 `pnpm cf-typegen:watchdog`。

### 手动 Actions

维护用的接管和恢复两个 `workflow_dispatch` 工作流尚待实现，使用同一套 catch-all 操作约定，分别负责 Route 修改、读回与公开来源核对。Actions 可以共享 concurrency group，但它不约束探活 Cron；需要保持人工选择时先停用 watchdog 并确认在途执行结束，恢复仍需检查固定 Node 入口。不引入 DO，也不把额外迁移验收或独立恢复演练作为前置；日常故障与恢复由 watchdog 自动处理，不依赖这些 Actions。
