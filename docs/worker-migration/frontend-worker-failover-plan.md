# 前端单副本与 Worker 后端故障接管方案

- 方案状态：已确认前端部署边界及自动接管方向，尚未实施
- 讨论日期：2026-09-04
- 补充决策：2026-09-06，首页当前上游实例列表随 RSS 承接环境切换，待实施
- 适用域名：`rsshub-balancer.virworks.moe`

## 目标

这套方案服务于 Node/Hono 云下迁移，优先目标是降低正常流量产生的 Cloudflare Worker CPU Time，同时保留当前自然的 URL 形式：

- `https://rsshub-balancer.virworks.moe/` 是首页。
- `https://rsshub-balancer.virworks.moe/<rss-path>` 返回对应 RSS 结果。
- 前端只在 Cloudflare Workers Static Assets 保留一份，不在云下重复部署。
- 正常状态下，公开 RSS 请求不执行任何 Worker 脚本，直接进入云下 Node/Hono。
- 云下故障时，由当前 `rsshub-balancer` Worker 接管公开 RSS 请求。

本方案只确定前端部署和请求路由边界。日志继续在各自运行平台查看；首页桑基图所需的数据汇聚已经另行确定，见 [云下桑基图数据回传 Analytics Engine 方案](./sankey-analytics-engine-ingestion-plan.md)。

## 结论

**保留当前这一份同时包含前端 Static Assets 和 Hono 后端代码的 `rsshub-balancer` Worker，不拆成前端 Worker 与后端 Worker。**

同一个 Worker 在不同状态下承担不同范围的请求：

- 正常状态：只通过更具体的前端 Route 提供首页、静态资源及桑基图内部接口；首页当前上游实例列表由云下 Node 返回。
- 故障状态：临时增加整域 `/*` Route，让同一个 Worker 中已经存在的 Hono 后端接管 RSS。

前端和备用后端虽然位于同一个 Worker deployment，但 Workers Static Assets 默认使用 asset-first 路由。请求命中真实静态文件时，Cloudflare 直接返回资源，不执行 Worker 脚本。因此，平时保留备用 Hono 代码不会让首页和静态资源请求执行 RSS 业务逻辑。

首次迁移只准备和验证云上业务 Worker、云下 Node 及两侧配置，在 Cloudflare Dashboard 手动修改 Workers Routes 完成切换。探活 Worker、固定探活域名、自动接管专用凭据、两个切换 Actions 及自动接管演练均后置，不作为首次迁移的前提。

后续已确认的接管方向（2026-09-05，尚未实施）：新增一个独立的探活 Worker，定时探测云下专用入口的 `/healthz`，在确认不可用后直接通过 Cloudflare API 启用 catch-all Route。两份手动触发的 GitHub Actions 分别提供“切到云上”（`switch-to-cloud.yml`）和“恢复云下”（`switch-to-origin.yml`），也直接调用 Route API，不引入 DO 或共同控制入口。自动化只切到云上，恢复云下始终由操作者发起。探活 Worker 不承接公开 RSS；业务仍使用当前这一份前端与备用后端组合 Worker，本文的 Route 边界保持不变。首次迁移、探活目标、切换验证及并发限制见 [迁移与故障接管操作手册](./migration-failover-runbook.md)。

## 正常状态

域名保留一条指向云下入口的橙云 DNS 记录：

```text
rsshub-balancer.virworks.moe -> 云下公网 IP
```

前提是移除或确认不存在 `rsshub-balancer.virworks.moe` 的 Worker Custom Domain。Custom Domain 会让 Worker 成为整个 hostname 的 origin；只删除 catch-all Route 并不能让其余 RSS 路径进入云下。这里必须使用“橙云 DNS 指向云下 origin + Workers Routes 选择少数路径”的形态。

Cloudflare Workers Routes 只把前端相关路径交给现有 Worker：

```text
rsshub-balancer.virworks.moe/             -> rsshub-balancer
rsshub-balancer.virworks.moe/_assets/*    -> rsshub-balancer
rsshub-balancer.virworks.moe/_internal/*  -> rsshub-balancer
```

请求链路如下：

```text
GET /
  -> Workers Static Assets
  -> dist/apps/web/index.html

GET /_assets/<file>
  -> Workers Static Assets
  -> dist/apps/web/_assets/<file>

GET /_internal/<path>
  -> rsshub-balancer Worker 脚本

GET /<rss-path>
  -> 未命中 Workers Route
  -> Cloudflare 橙云代理
  -> DNS origin
  -> Traefik
  -> Node/Hono
```

`/_internal/*` 继续长期保留：桑基图查询接口仍由 Worker 提供，云下 Node 的桑基图数据也通过其中受保护的 ingest 接口批量写回 Analytics Engine。首页当前上游列表改用下文约定的 `/api/upstreams`，正常状态由 Node 返回。完整指标数据流见 [云下桑基图数据回传 Analytics Engine 方案](./sankey-analytics-engine-ingestion-plan.md)。

正常状态不配置下面这条 catch-all Worker Route：

```text
rsshub-balancer.virworks.moe/* -> rsshub-balancer
```

因此，占主要流量的 RSS 路径不会进入 Worker，不产生对应的 Worker 脚本 CPU Time。

## 故障接管状态

确认云下 Node/Hono 不适合继续接收流量后，新增或启用：

```text
rsshub-balancer.virworks.moe/* -> rsshub-balancer
```

此时：

```text
GET /
  -> 同一个 Worker 的 Static Assets

GET /_assets/<file>
  -> 同一个 Worker 的 Static Assets

GET /_internal/<path>
  -> 同一个 Worker 的内部接口

GET /<rss-path>
  -> 同一个 Worker 的 Hono 后端
  -> Worker 按现有逻辑选择 RSSHub upstream
```

前端 Routes 与故障 catch-all Route 最终都指向同一个 Worker。更具体的 Route 会优先匹配，但由于目标脚本相同，不会产生跨 Worker 调用或版本不一致。

恢复云下服务并验证通过后，手动运行“恢复云下”Action，直接调用 Cloudflare API 删除 catch-all Route，保留三条前端 Route，即恢复正常状态。正常状态下 RSS 全部进入云下，首页及内部接口继续留在云上；这里没有按请求做 99/1 权重分流。

已确认的日常发布流程（2026-09-05，尚未实施）也复用这个开关：先手动切到 Worker 并确认接管，再用 Compose 更新云下单实例，直接验证云下新版本后手动切回。新版失败时继续由 Worker 服务，在云下回滚；不为发布引入蓝绿或多副本。完整流程见 [云下镜像发布与 Worker 临时接管方案](./origin-release-plan.md)。

已确认的状态边界（2026-09-05，尚未实施）：云下 Node 与备用 Worker 共用同一个 Redis 实例，但分别使用 `origin:` 和 `worker:` key 命名空间，各自维护健康实例列表和路径失败标记。接管时 Worker 读取自己的状态，避免把 Node 出口故障留下的失败判断继续用于云上选路；恢复时 Node 同样使用自己的状态。Route 切换不复制或交换这些 key。具体约定见 [Node/Hono 部署分析：云上和云下的 Redis 状态隔离](./node-hono-deployment-analysis.md#云上和云下的-redis-状态隔离)。

### 首页当前上游实例列表随承接环境切换

已确认修改要求（2026-09-06，待实施）：首页保留“当前上游实例”的含义。正常状态显示云下 Node 当前选路使用的实例列表；Worker 接管后显示云上当前使用的列表；恢复云下后重新显示 Node 列表。本决定替代“首页始终展示 Worker 视角列表”的旧约定。

将首页读取地址从 `/_internal/upstreams` 改为同域名的 **`GET /api/upstreams`**，在共享应用中挂载同一个 handler，由请求所在运行时注入状态存储和后台任务能力：

| 流量状态 | `/api/upstreams` 的请求去向 | 返回列表的来源 |
| --- | --- | --- |
| 正常云下 | 不命中三条长期 Worker Routes，经 Traefik 到 Node | Node 的 `getUpstreams()`，使用本进程实例缓存与 `origin:` 状态 |
| Worker 接管 | 命中业务 catch-all Route，由 Worker 执行 | Worker 的 `getUpstreams()`，使用当前执行环境的实例缓存与 `worker:` 状态 |
| 恢复云下 | 删除 catch-all 后重新到 Node | Node 的 `getUpstreams()`，继续沿用自己的状态 |

接口与普通 RSS 共用同一流量开关，不增加 `/api/upstreams` 的长期 Worker Route，也不配置会挡住接管的 no-script 例外。三条长期前端 Routes 和故障切换操作保持现有形式。页面通过相对路径请求该接口，无需查询 Routes API、携带控制面凭证或自行判断云上、云下状态。

“当前使用”指该运行环境按现有 `getUpstreams()` 语义取得的候选列表快照；应复用选路使用的读取函数、进程缓存和后台刷新规则，不能另行直读 Redis 后把尚未被应用采用的列表当作当前列表。状态读取失败时，继续使用该函数已有的旧缓存或固定 fallback 语义；不为了页面额外探测全部上游。列表不表示某一条 Feed 最终选中的单个实例，也不增加 Worker 不同 isolate 之间的缓存一致性保证。

接口和页面约定：

- 保持成功响应结构 `{ "upstreams": ["https://example.com"] }`，沿用 GET-only、其它方法返回 `405` / `Allow: GET`、带 query 返回 `400` 的边界。
- handler 必须挂载在 `/api/*` 的 404 规则和 RSS catch-all 之前；接口自身不转发 RSS，不生成 `route_request` 指标。
- 两端响应均设置 `Cache-Control: no-store` 与 `Cloudflare-CDN-Cache-Control: no-store`，页面请求禁用缓存；沿用 Zone Cache 对 `/api/*` 的排除及 Worker 的路径级禁止缓存策略。
- 查询失败时页面显示列表暂不可用，不改查另一端列表作为成功结果。云下故障但尚未接管时，允许首页仍能打开、列表暂时加载失败。
- 流量切换生效后，页面下一次加载或刷新列表时查询新的承接环境；首版不增加浏览器推送或后台轮询。切换传播期间以本次实际处理查询的环境为准，不声称所有客户端同时更新。
- 兼容旧前端时，Worker 上的 `/_internal/upstreams` 暂时保留为禁止缓存的 `307` 重定向，目标固定为 `/api/upstreams`；先执行原有方法和 query 校验。由浏览器继续发起公开请求，旧接口不再直接返回固定的 Worker 列表。

待实施清单：

- [ ] 从现有 `routes/internal.ts` 提取上游列表 handler，作为共享 `/api/upstreams` 路由供 Node、Worker 使用。
- [ ] 修改首页 `loadUpstreams()` 的请求地址与缓存选项，保留“当前上游实例”标题，同步两种语言的说明，明确展示当前承接环境的候选列表。
- [ ] 在 Worker 增加旧接口的过渡重定向，先确保两端新接口均可用，再切换首页读取地址及公开流量。
- [ ] 用两端不同的实例列表验证正常、接管、恢复三种状态，并覆盖旧接口重定向、缓存禁止、查询失败和原有 fallback 行为。

## 为什么不拆分前端与备用后端 Worker

拆成 `frontend Worker` 与 `backend Worker` 不会进一步降低正常状态下的 RSS Worker CPU Time：正常 RSS 请求是否执行 Worker，只由它是否命中 Worker Route 决定，与备用后端代码是否和前端处于同一个 bundle 无关。

保持一个业务 Worker 还有以下好处：

- 前端始终只有一个部署版本。
- 故障接管继续使用当前已经验证过的完整 Worker 产物。
- 前端与备用后端之间不需要 Service Binding，也不需要两套业务 Worker 部署配置；独立探活 Worker 的部署另行管理。
- 不需要协调前端 Worker 与备用后端 Worker 的版本。
- 故障和恢复都只改变 catch-all Route，不改变 DNS 和前端 Routes。

只有出现以下独立需求时，才重新评估拆分：

- 前端和备用后端必须采用不同发布周期。
- 两者需要隔离权限、secrets 或运维责任。
- 两者必须使用无法共存的入口级缓存配置。
- 备用后端明确要求只能通过 Service Binding 访问。

这些需求目前都不是云下迁移的必要条件。

## 与当前仓库的对应关系

当前配置已经具备保留单一 Worker 所需的基础：

- `apps/server/wrangler.jsonc` 的 `assets.directory` 指向 `dist/apps/web`。
- `assets.not_found_handling` 为 `none`，未知 RSS 路径不会被错误改写为前端 `index.html`。
- `assets.run_worker_first` 只让内部接口、API、健康检查和 `robots.txt` 优先进入脚本。
- `apps/server/src/index.ts` 已对缺失的 `/_assets/*` 明确返回 404。
- `apps/server/src/index.ts` 的 `/*` catch-all 已是故障状态下需要启用的 RSS 后端。
- `apps/server/project.json` 的 Worker build/deploy 已依赖 Web build。

云下 Node/Hono 部署不需要携带 `dist/apps/web`，也不需要复刻 Workers Static Assets 行为。它只需要处理正常状态下未命中前端 Routes 的后端路径。

## Route 管理边界

Workers Routes 继续作为 zone 级配置管理，不写回 `apps/server/wrangler.jsonc`。原因是前端 Routes 与故障 catch-all Route 共同构成域名级流量开关，不能由普通 Worker deployment 隐式覆盖。

以下配置分别管理：

- `pnpm deploy`：只发布同一个 Worker 的代码、bindings 和 Static Assets。
- 首次迁移配置：在 Dashboard 手动建立三条长期前端 Routes、调整临时 catch-all Route，并核对 DNS、Custom Domains 和旧 Route。
- 后续独立探活 Worker 与两份手动 Actions：分别直接调用 Cloudflare API 操作临时 catch-all Route。两个 Actions 使用同一 concurrency 组，Cron 与 Actions 之间不保证严格互斥，通过写前复查、写后读回和人工复核处理竞态。具体步骤和应急操作见 [迁移与故障接管操作手册](./migration-failover-runbook.md)。

实际实施前必须重新读取线上 Route ID、pattern 和 script 绑定，不能从本文推断当前线上状态。

还必须独立读取 Worker Custom Domain 列表，确认目标 hostname 已经从 Custom Domain 切换为普通橙云 DNS。不能只根据 Workers Routes 列表推断这一点。

## 路由边界与特殊 URL

Cloudflare Workers Route 会匹配完整 URL，包括 query string。精确 Route：

```text
rsshub-balancer.virworks.moe/
```

只覆盖没有 query string 的首页，不覆盖：

```text
rsshub-balancer.virworks.moe/?utm_source=example
```

如果要支持带 query 的首页，建议使用一条不执行 Worker 的 Cloudflare Single Redirect，将 `path = /` 且 query 非空的请求规范化到 `/`。不要把首页 Route 改成 `rsshub-balancer.virworks.moe/*`，否则正常状态下所有 RSS 请求都会重新进入 Worker。

直接访问 `/index.html` 是否跳转到 `/` 也应在实施时明确。推荐用 Single Redirect 统一到 `/`，避免再增加一条长期 Worker Route。

## 缓存说明

当前 `apps/server/wrangler.jsonc` 启用了 Workers Cache。它与 Static Assets 的 asset-first 行为是两套不同机制：

- Static Assets 命中真实文件时不执行 Worker 脚本。
- Workers Cache HIT 同样不执行 Worker 脚本，因此不产生 CPU Time。
- 但启用 Workers Cache 后，静态资源请求可能按普通 Worker request 计费。

已确认的缓存边界（2026-09-05，尚未实施）：正常 RSS 使用 Zone Cache，通过单条 Cache Rule 排除前端和保留接口，其余业务路径默认允许缓存；有上游缓存头时遵循上游，没有时使用平台默认行为。组合 Worker 保留当前 Workers Cache，故障接管时继续使用自己的缓存策略。前端仍由 Static Assets 管理，不纳入 RSS 缓存规则。完整表达式、`no-store` 边界和默认 TTL 差异见 [云下 RSS 的 Zone Cache 方案](./zone-cache-plan.md)。

## 验证清单

### 正常状态

- `/` 由 Workers Static Assets 返回。
- `/_assets/<known-file>` 由 Workers Static Assets 返回。
- 缺失的 `/_assets/<file>` 返回 404，不进入 RSS 代理。
- `/_internal/*` 仍由现有 Worker 接收。
- `/api/upstreams` 由 Node 返回与其选路读取函数一致的列表；旧 `/_internal/upstreams` 重定向后的结果同样来自 Node。
- 受保护的 metrics ingest POST 命中 Worker，而普通 RSS 路径仍没有 Worker invocation。
- 目标 hostname 不存在 Worker Custom Domain 绑定。
- 普通 RSS 路径在 Worker 日志中没有 invocation，并出现在 Node/Traefik 日志中。
- 带 query 的首页按约定完成规范化，不会被 Node 当作 RSS 路径。

### 故障状态

- 启用 catch-all Route 后，普通 RSS 路径进入现有 Worker。
- `/api/upstreams` 同时切到 Worker；即使 Node 停止，首页下一次查询仍能取得 Worker 自身使用的列表。
- Node 出口故障已在 `origin:` 空间留下失败标记时，Worker 仍只读取 `worker:` 空间，并能通过完整选路访问从云上可达的上游。
- 首页和静态资源仍由同一份 Static Assets 返回。
- Worker 的 GET、HEAD、405、404 和响应头行为与切换前的云上基线一致。
- DNS 记录没有随故障切换变化。

### 恢复状态

- 删除 catch-all Route 后，普通 RSS 路径重新进入 Node/Traefik。
- 首页重新查询 `/api/upstreams` 后恢复为 Node 列表，响应不复用接管期间的 HTTP 缓存。
- Node 继续读取 `origin:` 空间，不读取或复制 Worker 的健康实例列表和失败标记。
- 三条长期前端 Routes 保持不变。
- 线上 Route read-back 与预期的 pattern、script 和数量一致。

## 不采用的方案

### 云下再部署一份前端

会长期产生两个前端版本，需要协调 HTML 与带 hash 静态资源，不符合前端只保留一个云上版本的目标。

### 常驻全域 Gateway Worker

虽然只需一条 `/*` Route，但每个 RSS 请求都会执行一层 Worker 转发。网络等待不计 CPU Time，分支、请求构造和响应处理仍会产生与流量线性增长的 Worker CPU，不符合本次迁移初心。

### 拆成前端 Worker 与备用后端 Worker

正常 RSS 仍可绕过 Worker，但会增加第二个 Worker deployment、bindings 和版本协调；在当前没有独立发布或权限隔离需求时，收益不足。

## 参考资料

- [Cloudflare Workers Routes：匹配、优先级与 no-script](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Cloudflare Workers Custom Domains：Worker 作为整个 hostname 的 origin](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare Workers Static Assets：默认路由行为](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Workers Static Assets：Worker-first 控制](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [Cloudflare Workers Cache：执行位置与计费](https://developers.cloudflare.com/workers/cache/)
- [Node/Hono 云下部署可行性与 Cloudflare 依赖审计](./node-hono-deployment-analysis.md)
- [云下桑基图数据回传 Analytics Engine 方案](./sankey-analytics-engine-ingestion-plan.md)
- [云下 RSS 的 Zone Cache 方案](./zone-cache-plan.md)
- [Cloudflare 路径级云下直连方案](../cloudflare-origin-bypass.md)
