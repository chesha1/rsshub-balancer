# 云下 Node/Hono 部署可行性与 Cloudflare 依赖审计

- 审计日期：2026-09-04
- 代码基线：`a1cf1b2`
- 审计范围：`apps/server`、前端静态资源接入方式、Nx/pnpm/TypeScript/Wrangler 配置及现有文档。本文只做静态审计与少量运行时行为验证，不包含真实流量压测。

## 结论

**可以迁到普通云服务器上的 Node/Hono，但当前代码不能原样启动，也不能只加一行 `serve(app)`。**

核心代理逻辑的可移植性很好：Hono 路由、`fetch`、`Request`、`Response`、`Headers`、`URL`、`AbortSignal.timeout`、Redis 状态语义和结构化日志都能在现代 Node.js 中继续使用。真正绑定 Cloudflare 的部分集中在运行时入口和外围能力，而不是缓存感知路由算法本身。

### 已确认的迁移范围（2026-09-05）

本次以旧 Workers 版的业务配置和失败行为为基线，只处理迁到云下新增的平台适配与行为差异。旧版已经存在的限制视为本次接受的行为，不作为设计缺口、迁移阻塞或新增容错要求。

以下两项已经决定沿用现状，无需再讨论新的保障目标：

| 问题 | 本次迁移决定 |
| --- | --- |
| 一个请求最多等待多久、尝试多少节点，过载时怎么办 | 保留现有单次超时、探测与顺序尝试逻辑、固定 fallback 及旁路比例。不新增请求总时限、最大尝试节点数、全局并发预算、排队或过载降级机制 |
| Redis 或实例刷新失败时，服务继续工作到什么程度 | 保留现有状态读取、内存缓存、失败标记与定时刷新错误处理。不新增旧列表最大陈旧期、额外重试、持久化兜底或故障期间的可用性保证 |

运行时入口、后台任务执行和定时触发仍需适配，但不能借适配改变上述业务语义。已确认的 `origin:` / `worker:` 状态隔离继续实施，因为它处理的是两个运行环境并存后新增的健康判断差异。

按目标区分，判断如下：

| 目标 | 可行性 | 判断 |
| --- | --- | --- |
| 单机、单进程、只保留 Feed 代理，使用 Redis | 高 | 做完 Node 入口、环境注入、后台任务适配后即可运行 |
| 同时保留首页静态资源和基础状态接口 | 高 | 额外复刻 Workers Static Assets 的路由顺序 |
| 保留现有 Cloudflare 地理/机房桑基图 | 中 | 查询 API 可继续调用，但 Node 流量无法用现有 binding 写入 Analytics Engine |
| 完全脱离 Cloudflare，并保持当前缓存和观测效果 | 中低 | 需要替换 CDN 缓存、指标、地理元数据，以及线上若另有依赖的 WAF/DDoS/限流等外围能力 |
| 多进程或多副本生产部署 | 中 | 还要处理 Redis 连接生命周期、定时任务单例、优雅退出和进程内缓存一致性 |

推荐的首版形态是：

```text
可选的 Cloudflare CDN/WAF
          ↓
Traefik / Caddy / Nginx（TLS、请求转发）
          ↓
单进程 Node.js + Hono
          ↓
共享 Redis / Valkey（Node 使用 origin: 命名空间）
```

先以单副本上线和对照验证为目标，不建议第一步同时做完全去 Cloudflare、多副本和观测系统重建。

已确认的发布边界（2026-09-05，尚未实施）：云下单实例使用 Docker Compose，发布时先手动让已有 Worker 接管，确认后更新云下镜像，直接验证通过再手动切回。新版失败时保持 Worker 接管并在云下回滚，不以蓝绿、Swarm、Kubernetes 或多副本作为发布前提。镜像版本、流量切换、回滚和退出约定见 [云下镜像发布与 Worker 临时接管方案](./origin-release-plan.md)。

首次迁移只准备和验证云上业务 Worker、云下 Node 及两侧配置，再在 Cloudflare Dashboard 手动修改 Workers Routes 完成切换；不依赖探活 Worker 或切换 Actions。直接验证 Node 可使用服务器本机或受控内部入口，固定探活域名、探活鉴权和 Route API token 均留到后续自动化阶段。

后续故障接管设计见 [操作手册](./migration-failover-runbook.md)：独立探活 Worker 探测固定云下入口的 `/healthz` 并自动接管，两个手动 Actions 提供切到云上和恢复云下，均直接调用 Cloudflare Route API，不引入 DO。启用自动化时再补充健康检查的运行环境标记和云下探活鉴权；Node `/readyz` 的就绪语义及禁止缓存行为仍属于两侧运行配置。这些不改变现有上游健康判断或业务选择策略。探活 Worker、Actions 及新增探活契约均尚未实施，自动接管演练也不是首次迁移的前提。

## 判断口径

本文把依赖分成三类：

- **强依赖**：当前代码直接调用 Workers 专属接口或依赖平台触发；普通 Node 环境没有等价对象，不改会报错、功能丢失或路由行为明显改变。
- **条件依赖**：只有启用某个后端或保留某项功能时才依赖 Cloudflare，可以在 Node profile 中关闭或替换。
- **弱依赖/语义依赖**：不会阻止进程启动，但数据含义、缓存效果或可观测性会退化。

总览如下：

| 能力 | 依赖程度 | 原样迁到 Node 的结果 | 处理方向 |
| --- | --- | --- | --- |
| Worker module 入口、Wrangler dev/build | 强 | 没有端口 listener，也没有 Node 可执行产物 | 新增 Node adapter 和 build target |
| `c.executionCtx.waitUntil` | 强 | 在触发后台刷新或失败标记时抛错 | 注入平台无关的后台任务执行器 |
| Cron Trigger | 强 | 实例列表不再按小时刷新 | 外部 timer/job 或单例 scheduler |
| Analytics Engine 写 binding | 强 | 指标丢失并持续记录 warning | no-op 或替换 metrics sink |
| Workers Static Assets | 条件强依赖 | 若要求同域首页，`/` 会错误进入 Feed 代理 | 反代或 Node static adapter 复刻优先级 |
| Workers KV | 条件强依赖 | 选择/回退到 KV 时运行失败 | Node 强制 Redis，KV 留在 Worker adapter |
| Analytics Engine SQL API | 产品依赖、协议可移植 | Node 能请求，但仍依赖 Cloudflare 且没有云下新数据 | 过渡期只读或整体换数据源 |
| `request.cf` | 弱 | country/colo 退化为 unknown | 可信代理头、GeoIP 或删除维度 |
| Workers Cache、专属 cache header | 语义依赖 | 不崩溃，但边缘命中消失、no-store 可能失效 | CDN/反代缓存规则 + 标准响应头 |
| Workers Observability | 部署依赖 | 应用仍运行，但平台日志和 tracing 消失 | stdout JSON + 日志/Tracing 后端 |
| `nodejs_compat` | 非迁移障碍 | Node 原生支持当前用到的 API | Node 侧不需要兼容层 |

## 必须适配的边界

### 1. Worker 入口和构建链路

当前默认导出是 Workers module handler：

- `apps/server/src/index.ts:226-229` 导出 `{ fetch, scheduled }`，没有 Node HTTP listener。
- `apps/server/package.json:5-12` 没有 `@hono/node-server`。
- `apps/server/project.json:8-47` 的开发、构建、部署和类型生成全部走 Wrangler。
- `apps/server/tsconfig.json:5` 设置了 `noEmit: true`；当前 `dist/apps/server` 也不是 Node 可执行产物。

因此这是一个 **P0 启动阻塞**。Hono 官方的 Node 运行方式需要 `@hono/node-server` 的 `serve()` 适配器。建议保留 Worker 入口，再新增独立 Node 入口，不要让平台判断散落到业务路由中。

当前 TypeScript 使用 `moduleResolution: "Bundler"`，源码相对导入也没有 `.js` 扩展名，见 `tsconfig.base.json:3-8`。Node 产物优先用 bundler 生成 ESM bundle；如果坚持直接用 `tsc` emit，需要切换到 NodeNext 语义并处理导入扩展名。

### 2. `CloudflareBindings` 与 `c.env`

`apps/server/src/types.ts:3-7` 把整个 Hono 应用固定成 `CloudflareBindings`。生成的 `apps/server/worker-configuration.d.ts:4-24` 又把 KV、Analytics Engine、静态资源 binding 和 secrets 一起注入成全局类型。

Node adapter 不会把 `process.env` 自动变成这些业务 bindings。即使 Node 请求能进入 Hono，当前代码仍拿不到：

- `KV`
- `METRICS`
- `STATE_STORE_BACKEND`
- `VALKEY_URL`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ANALYTICS_API_TOKEN`

建议定义平台无关的最小应用依赖，由 Worker adapter 和 Node adapter 分别组装。不要在 Node 中伪造整套 `CloudflareBindings`，否则平台耦合只是被隐藏，后续仍难以测试。

### 3. `ExecutionContext.waitUntil`

当前这些请求路径会使用 `c.executionCtx.waitUntil()`：

- `apps/server/src/index.ts:118-121`：`/healthz`
- `apps/server/src/index.ts:139-147`：`/api/route/status`
- `apps/server/src/index.ts:209-212`：公开代理主路径
- `apps/server/src/routes/internal.ts:73-76`：`/_internal/upstreams`

Hono 在没有 ExecutionContext 时读取 `c.executionCtx` 会抛出 `This context has no ExecutionContext`。使用当前 Hono 4.13.5 做了最小验证：不传第三个 execution context 的 `app.request()` 访问 `waitUntil` 路由会返回 500。

这个错误不一定在每个请求上立刻出现：首次状态读取失败可能被 fallback 吞掉，但在实例内存缓存过期触发后台刷新，或上游失败需要后台写入失败标记时会暴露。因此“刚启动看起来能响应”不能证明迁移成功。

好消息是底层代码已经把后台提交抽成 callback：

- `apps/server/src/upstream.ts:12-14` 定义可选 `waitUntil`。
- `apps/server/src/upstream.ts:164-168` 给转发函数注入提交函数。

下一步应把它提升为运行时无关的 `defer`/background-task 接口：

- Worker adapter 转调 `ctx.waitUntil()`。
- Node adapter 跟踪 Promise、记录 rejection，并在优雅退出时等待未完成任务。
- 后台刷新和失败标记写入沿用现有错误处理，不因替换 `waitUntil` 而增加可靠落盘、队列或重试要求。

### 4. Cloudflare Cron Trigger

`apps/server/wrangler.jsonc:60-62` 每小时触发一次 `scheduled`，函数签名位于 `apps/server/src/scheduled.ts:7-12`。`ScheduledEvent` 和 `ExecutionContext` 是 Workers 类型，普通 Node 不会自动触发它。

刷新业务本身并不依赖 Cloudflare：`apps/server/src/scheduled.ts:20-57` 只是拉取实例列表、并发检查 `/healthz`、写状态存储和更新内存缓存。建议把它抽成普通的 `refreshInstances` service，再选择一种 Node 调度方式：

- 单实例：进程启动时执行一次，再用防重入的进程内 timer。
- 以后若扩展为多副本：再评估 systemd timer、系统 cron、独立 job 容器，或带 Redis 分布式锁的单例调度器。

如果把刷新任务做成独立短进程，它更新的模块内存缓存不会同步到 Web 进程；Redis 中的新列表仍会在各 Web 进程下次刷新时被读取。

### 5. Workers KV

KV 实现位于 `apps/server/src/store.ts:552-592`，直接使用 `KVNamespace` 和 `expirationTtl`，这是 Cloudflare 强依赖。

不过 KV 不是仓库当前的默认部署路径：`apps/server/wrangler.jsonc:17-20` 配置为 `STATE_STORE_BACKEND=redis`，仓库也已经有统一 `StateStore` 接口和两套可迁移实现：

- 直连 Redis/Valkey：`apps/server/src/store.ts:595-658`
- Redis HTTP：`apps/server/src/store.ts:660-715`

这里的真正风险是默认行为。`apps/server/src/store.ts:121-139,717-723` 在环境变量缺失或值未知时会回退到 KV。Node 环境没有 `env.KV`，会在首次读写时失败；部分错误又会被上层降级成固定 fallback upstream，形成“服务表面存活、状态能力实际失效”的隐性故障。

Node profile 应当：

1. 启动时强制选择 `redis` 或 `redis-http`。
2. 在监听端口前校验 URL、token 等必需配置。
3. 对未知 backend fail fast，不要自动回退到不存在的 KV。

### 6. Workers Analytics Engine

这是功能层最明显的 Cloudflare 强依赖，包含写入和查询两部分。

写入侧：

- `apps/server/wrangler.jsonc:35-39` 声明 `METRICS` dataset binding。
- `apps/server/src/metrics.ts:35-61` 直接调用 `AnalyticsEngineDataset.writeDataPoint()`。
- `apps/server/src/index.ts:214-222` 无条件传入 `c.env.METRICS`。

普通 Node 没有这个 binding。当前函数会捕获 `metrics.writeDataPoint` 的异常，所以进程未必崩溃，但每个被记录的请求都会产生日志告警，指标本身全部丢失。

查询侧：

- `apps/server/src/routes/internal.ts:101-145` 通过普通 HTTPS 请求调用 Cloudflare Analytics Engine SQL API。

查询代码可以在 Node 中继续运行，但仍依赖 Cloudflare account/token，而且只能查询 Cloudflare dataset。Node 新流量如果没有新的写入通道，就不会出现在首页桑基图中。

可选迁移顺序：

1. 最低可用：注入 no-op metrics sink，并关闭或明确标记首页流量图不可用。
2. 过渡期：Node 继续只读 Cloudflare 历史数据，但 UI 明确数据范围，避免误以为包含云下流量。
3. 完整替换：抽象 `MetricsSink` 和聚合查询接口，接 Prometheus/OpenTelemetry/ClickHouse/关系库等，再改首页查询数据源。

如果专门新增一个 Worker 作为 Analytics Engine 写入代理，技术上也能保留图表，但这只是把 Cloudflare 依赖移动到网络边界，并没有消除它。

后续决策（2026-09-04）：可观测需求已经收窄为首页桑基图，不要求统一日志或 tracing，并且接受该图继续依赖 Cloudflare。因此最终选择复用现有 Worker 的长期 `/_internal/*` Route，增加受保护的批量 ingest 接口，由 Node 把指标送回同一个 Analytics Engine 数据集；这是一项有意保留的窄平台依赖，不作为通用 metrics gateway。完整方案见 [云下桑基图数据回传 Analytics Engine 方案](./sankey-analytics-engine-ingestion-plan.md)。

### 7. Workers Static Assets

`apps/server/wrangler.jsonc:11-16` 让平台从 `dist/apps/web` 提供前端静态文件，并对 `/_internal/*`、`/api/*`、`/healthz`、`/robots.txt` 使用 worker-first 路由。

源码没有直接调用 `env.ASSETS`，但资产路由顺序依赖平台。Node 如果只启动当前 Hono app，`apps/server/src/index.ts:172-223` 的 `/*` catch-all 会把 `/` 当成 RSSHub Feed 路径转发，而不是返回首页。

如果云下只部署 API，可以使用独立 API 域名、明确不提供首页，或者通过更具体的 Workers Routes 让前端继续留在云上。若不使用这类路径分流但仍要由云下保持现有站点行为，应由 Node `serveStatic` 或前置反向代理复刻下面的语义：

1. 后端接口和保留路径先进入 Hono。
2. `/` 和实际存在的前端文件从 `dist/apps/web` 返回。
3. 静态文件不存在时继续进入 Hono；不能给所有未知路径做 SPA fallback，否则会吞掉 RSSHub Feed 路由。
4. 缺失的 `/_assets/*` 最终保持 404。

后续已经确定当前迁移采用另一种同域部署边界：前端只在现有组合 Worker 保留一份，正常状态通过更具体的 Workers Routes 提供首页和静态资源，其余 RSS 路径进入云下 Node；故障时再由同一个 Worker 的 catch-all Route 接管 RSS。Node 因此不需要部署静态文件。完整决策见 [前端单副本与 Worker 后端故障接管方案](./frontend-worker-failover-plan.md)。

## 不阻止启动，但会改变行为的 Cloudflare 依赖

### `request.cf`

`apps/server/src/metrics.ts:14-31` 和 `apps/server/src/log.ts:134-146` 读取 `request.cf.country/colo`。`.cf` 是 Workers 对标准 Request 的扩展，Node Request 没有该属性。

当前实现已经安全降级：国家和 colo 会成为 `unknown` 或不写日志，所以不会单独导致崩溃。但首页地域和入口机房数据会失真。处理方式取决于拓扑：

- 仍由 Cloudflare 代理：只从受信任的 Cloudflare/反代来源解析 `CF-IPCountry`、`CF-Ray` 等头，并限制 origin 不能被公网绕过。
- 完全脱离 Cloudflare：国家可用可信代理的 GeoIP 结果替代；`colo` 没有同义概念，应改成部署 region/ingress POP 或删除该维度。

不能无条件信任公网客户端传来的 `CF-*` 或 `X-Forwarded-*` 头。

此外，`apps/server/src/index.ts:88-93` 和 `apps/server/src/metrics.ts:47-60` 把层级固定标成 `edge`。Node profile 如果继续复用这些日志和指标，需要把 deployment layer 也改成可注入配置，否则云下流量会被错误标记为边缘流量。

### Workers Cache 与专属响应头

平台缓存配置在 `apps/server/wrangler.jsonc:7-9`。`apps/server/src/index.ts:68-75` 还假设 Cache HIT 可以在 Worker 执行前返回，并给实时路径写 `Cloudflare-CDN-Cache-Control: no-store`。

完全脱离 Cloudflare 后：

- 不再有这层边缘 HIT，回源量和 Node/上游负载会上升。
- `Cloudflare-CDN-Cache-Control` 对普通反向代理没有通用控制效果。
- 当前应用没有调用 `caches.default`，也没有自己的响应缓存可自动接替。

应在反代/CDN 层显式定义缓存规则，并给实时接口补充标准 `Cache-Control: no-store`。如果 Node origin 仍在 Cloudflare 后面，可以保留专属头，但 Wrangler 中的缓存配置不会自动迁移到 origin 部署，需要重新核对 zone Cache Rules。

后续决策（2026-09-05，尚未实施）：当前迁移保留橙云入口，普通 RSS 采用单条 Zone Cache Rule，排除前端和保留接口后默认允许缓存；有上游缓存头时遵循上游，没有时使用 Zone 默认行为。Node 保留实时接口的 `no-store`，不新增应用层响应缓存；备用 Worker 保留现有 Workers Cache。两侧优先保持轻量实现，接受默认 TTL、缓存生命周期和一般 `Vary` 等平台差异，不要求完整对齐；以正常 RSS 业务可用为边界，具体问题局部处理。原则与完整配置见 [云下 RSS 的 Zone Cache 方案](./zone-cache-plan.md#轻量缓存原则)。

### Observability

`apps/server/wrangler.jsonc:51-58` 的 Workers Logs/tracing 不会跟随 Node 进程迁移。应用日志本身大体可复用：`apps/server/src/log.ts:1,98-120` 使用 Node 原生 `AsyncLocalStorage` 和 console sink。

不过当前应用 logger 的最低级别固定为 warning，见 `apps/server/src/log.ts:108-119`；大量 info 级访问、成功转发和 cron 日志实际不会输出。Node 运行时应支持 `LOG_LEVEL`，输出 JSON 到 stdout，再交给 journald/Loki/日志平台采集和轮转。

### `nodejs_compat`

`apps/server/wrangler.jsonc:5-6` 的 `nodejs_compat` 是 Cloudflare 为 Node API 提供的兼容层。迁到 Node 后不需要替代，反而是迁移利好：

- `node:async_hooks` 原生可用。
- `@redis/client` 更符合常驻 Node 环境。
- `process.on('warning')` 原生可用。

### `@upstash/redis/cloudflare`

`apps/server/src/store.ts:2` 显式导入 Cloudflare 子入口。它在当前 Node 24 环境做 import 验证可以加载，且主要使用标准 `fetch`，所以不应视为当前硬阻塞。

但 Node 构建仍建议换成默认/Node 入口，或把 Redis HTTP client 隔离到平台 adapter，避免未来版本行为和 telemetry 假设发生变化。

## 明确不存在的当前强依赖

源码扫描没有发现这些正在使用的能力：

- D1
- R2
- Queues
- Service Bindings
- Durable Objects
- WebSocketPair
- HTMLRewriter
- 直接 Workers Cache API（`caches.default`）

`apps/server/wrangler.jsonc:41-49` 的 Durable Object migration 是历史账本：先新增、后删除 `RequestCoalescer`，当前没有 DO binding 或 class。`apps/server/src/types.ts:9` 的指标 outcome 也只剩 `direct_upstream`。

因此迁移评估不应把 Durable Object 或跨 isolate 请求合并算成当前能力。现有 `README.md:35-40,47-57`、`docs/capability-boundary.md:37-44` 和 `docs/metrics.md` 中关于 isolate/DO 合并的部分已经落后于源码，需要另行清理，但不影响本次 Node 可行性结论。

## 可以直接保留的核心

下列部分原则上不需要重写：

- Hono router 和大多数 middleware，`apps/server/src/index.ts:66-224`。
- 缓存感知选路、顺序 fallback 和标准 Fetch API 调用，`apps/server/src/upstream.ts`。
- `StateStore` 业务接口，`apps/server/src/store.ts:85-97`。
- Redis/Valkey 数据格式和 TTL 语义；key 必须按云上、云下分别增加命名空间，不能继续共用同一组状态 key。
- Request ID、结构化错误和 AsyncLocalStorage 日志上下文。
- 远程实例列表抓取和健康检查主体，`apps/server/src/scheduled.ts:20-57`。

推荐迁移策略是“核心 + 两个薄 adapter”，不是复制一份 Node 版业务逻辑。

已确认的代码组织和版本管理见 [Worker 与 Node 共享代码方案](./shared-code-runtime-plan.md)：保留一个 `apps/server` 包，通过两个入口组装平台能力，默认从同一 commit 构建两端产物。下表按已经确定的前端与桑基图方案收敛。

| 模块职责 | Worker 侧 | Node 侧 |
| --- | --- | --- |
| HTTP 入口 | module `fetch` | `@hono/node-server` `serve()` |
| 应用依赖 | `env` bindings | 启动时读取并校验环境变量后注入 |
| 后台任务 | `ctx.waitUntil` | 跟踪后台 Promise，保留现有错误处理 |
| 状态存储 | Redis、Redis HTTP 或 KV | Redis/Valkey，默认禁止 KV |
| 指标写入 | Analytics Engine binding | 有界 buffer，批量回传现有 Worker ingest |
| 请求位置 | `request.cf` | 原始请求的可信 Cloudflare headers；colo 语义按桑基图方案处理 |
| 定时刷新 | Cron Trigger | 单实例防重入 timer，调用同一刷新函数 |
| 静态资源 | Workers Static Assets | 不部署前端，前端只保留在 Worker |

建议的文件边界：

- `app.ts`：创建平台无关的 Hono app，只依赖显式 ports/services。
- `worker.ts`：Cloudflare bindings、`fetch`、`scheduled` 适配。
- `node.ts`：`serve()`、环境加载、端口、信号和 graceful shutdown。
- `refresh-instances.ts`：共享实例刷新函数，由 Worker Cron 或 Node timer 调用。
- `adapters/`：KV、Redis、Analytics Engine、Node metrics 等实现。

## Node 运行时适配与既有行为边界

本节区分运行时适配与旧版已有行为；后者按已确认范围保留，不因迁移而升级为必须解决的生产风险。

### Redis 连接生命周期

已确认决策（2026-09-05，尚未实施）：Node 的直连 Redis adapter 每进程复用一个 client，由同一进程内的多个请求共用连接，减少反复 TCP/TLS 建连的开销。Node 与 Worker 各自管理自己的 client；两端共用 Redis 实例及隔离 key 命名空间的规则见下一节。

当前直连实现为每条 Redis 命令执行 `connect -> command -> destroy`，见 [store.ts](../../apps/server/src/store.ts) 的 `createRedisClient`、`runRedisCommandWithTimeout` 和 `runRedisCommandWithFreshClient`。同一个 HTTP 请求中的多条 Redis 命令也分别建连。当前配置为建连超时 2 秒、建连成功后的单条命令另计 2 秒，并关闭自动重连和离线排队；命令超时由 `Promise.race` 返回异常，外层 `finally` 无论成功或失败都销毁该命令独占的连接。这是现有 Worker 实现的取舍，不能将这套销毁逻辑直接用于共享 client。

以下约定只用于 Node 的直连 Redis 适配。`redis-http` 复用的是封装 `fetch` 的 HTTP SDK 对象，不由应用维护 Redis TCP 长连接，继续使用现有逐次 HTTP 超时和不重试行为。

#### 连接复用与失效恢复

- 启动时校验连接配置；Redis 暂时不可达不新增为拒绝服务的门槛。首次状态操作按需建连，正常命令结束后保留 client。
- 首次建连和断线后建连都由 adapter 统一协调：同一时刻只发起一次建连，其他需要连接的操作等待同一个建连 Promise。建连成功后共享就绪 client；失败后清理 Promise 和失效引用，让后续操作可以重新建连。
- 沿用 2 秒建连超时、关闭离线排队及自动重连的配置；本次操作建连失败就走现有失败分支，由之后的新操作触发下一次建连。不在一次业务操作内循环重试，也不将旧命令排队到恢复后重放。
- 处理 client 的 `error` 事件，连接关闭或确认不可用时停止复用并清理该 client。普通 Redis 命令错误不直接等同于连接失效。异步清理只作用于它所属的 client / 建连 Promise，避免旧连接的迟到错误或完成回调清掉新连接。

这里的恢复能力是让下一次状态操作有机会使用新连接；Redis 持续不可达时，仍沿用已有错误处理，不承诺本次操作成功。[node-redis 重连与离线队列说明](https://redis.io/docs/latest/develop/clients/nodejs/produsage/)

#### 单条命令超时与收尾

每条命令从取得可用 client 并提交时起计算原有的 2 秒时限，覆盖客户端排队、发送及等待回复。调用方超时后立即走原有失败分支，不延长等待时间。

`Promise.race` 只结束调用方等待，不会自动取消底层命令。共享连接上，A 命令完成或超时后直接 `destroy()` 会中断仍在等待的 B 命令，因此由 adapter 统一负责以下收尾：

- 优先通过 SDK 取消尚未发送的超时命令，避免调用方已放弃后才执行。只有 SDK 能确认命令已在发送前取消时，才按单命令取消完成收尾；无法确认时按在途命令处理。实施时核对锁定 SDK 的取消语义，不能假设传入 `AbortSignal` 就能取消已经发送的 Redis 命令。
- 对已经发送或无法确认安全单独取消的超时命令，将该 client 标记为待关闭，停止接收新命令。保留 SDK 对回复顺序的管理，继续消费迟到回复和处理底层 Promise 的成功或失败；迟到结果不再更新本次业务状态，也不重新执行命令。
- 待关闭 client 上的其他已有命令可在各自原有时限内完成；收尾截止时间取标记待关闭时所有尚未收尾命令（含已超时命令）的原定截止时间中最晚者。若该时间已过或底层命令已全部结束，则立即关闭；否则最迟到期销毁旧 client，释放仍挂起的操作。收尾不会因新请求到来而延长，期间新的状态操作直接沿用 Redis 失败分支，旧 client 关闭后由后续操作统一建连。
- 如果底层连接已经断开或确认失效，可以立即清理，无需等待上述命令时限。同一连接上的其他在途命令也可能失败；共享连接不提供连接故障时的逐命令隔离保证。

无论超时、取消还是关闭连接，都不能保证已经送到 Redis 的写命令没有执行。因此不自动补发结果不明的写入，也不将调用方超时解释为写入已撤销。

这些改动全部集中在连接适配层，保留 `StateStore` 及选路层的现有语义：有实例列表缓存就继续用旧缓存，无缓存且读取失败时使用固定 fallback；失败标记读取失败时按未标记处理，写入失败时记录 warning；刷新失败继续保留旧列表。

进程收到 SIGTERM 后先按既定流程停止新工作并 drain，再关闭 client；待关闭连接的收尾也不得突破总退出时限，见 [云下退出要求](./origin-release-plan.md#云下退出要求)。

### 云上和云下的 Redis 状态隔离

已确认决策（2026-09-05，尚未实施）：Node 与备用 Worker 继续共用同一个 Redis / Valkey 实例，但使用两个独立的 key 命名空间。由运行时 adapter 固定选择 `origin:` 或 `worker:` 前缀，状态读写都必须使用对应前缀。

| 状态 | 云下 Node | 云上 Worker |
| --- | --- | --- |
| 健康实例列表 | `origin:instances` | `worker:instances` |
| 路径失败标记 | `origin:fail:<encoded-pathname>:<encoded-upstream>` | `worker:fail:<encoded-pathname>:<encoded-upstream>` |

当前失败标记没有运行环境维度，TTL 为 6 小时。如果 Node 出口故障后写入共享失败标记，切回 Worker 时，完整选路分支会跳过这些上游，甚至直接返回 502，即使 Worker 实际能够访问它们。因此，两边不能互相读取或复制失败标记。

`instances` 也必须隔离：当前刷新任务保存的是从执行环境检查 `/healthz` 后得到的健康子集，并非未经筛选的候选目录。两边可以使用相同的候选来源，但必须各自执行健康检查并写入自己的实例列表。Worker Cron 与 Node scheduler 分别维护各自命名空间；同一命名空间内的多副本再使用单例调度或锁，锁 key 也采用相同前缀。

启用新命名空间时，各自刷新实例列表；失败标记从各自的新空间开始积累，不复制旧共享失败标记，也不回退读取旧的无前缀 key。切换公开流量只改变请求去向，不交换两边的状态空间。

首页“当前上游实例”也随公开 RSS 的承接环境切换。2026-09-06 已确认待实施的共享 `/api/upstreams` 复用当前运行时的 `getUpstreams()`，正常状态显示 Node 的列表，接管时显示 Worker 的列表；沿用现有进程缓存、后台刷新及 fallback 语义，不跨命名空间读取或合并列表。接口、旧地址兼容与页面修改要求见 [前端方案](./frontend-worker-failover-plan.md#首页当前上游实例列表随承接环境切换)。

### 出站扇出和尾延迟：沿用 Workers 行为

每个进入完整选路的请求会：

1. 对所有健康 upstream 并发请求 `/api/route/status`，见 `apps/server/src/upstream.ts:228-248`。
2. 没有命中或命中失败后，最坏按上游逐个进行 15 秒请求，见 `apps/server/src/upstream.ts:270-338`。

`Promise.any` 找到胜者后没有主动取消其它探测，也没有覆盖整个请求的总 deadline。当前 `apps/server/src/index.ts:18-19,184-204` 还有硬编码 50% 请求直接去 fallback，它不是限流，也会让容量与指标判断变得复杂。

以上是 Workers 版已经存在的行为。云下继续使用同样的超时、候选范围、尝试顺序和旁路比例；本次不增加整体 request deadline、最大尝试次数、全局并发预算、限流、排队、过载降级或 probe 取消机制，也不将这些增强列为上线前提。

### 健康检查语义不适合直接做 liveness

当前 `/healthz` 的语义是“至少一个 RSSHub upstream 在 5 秒内健康”，见 `apps/server/src/index.ts:118-135`。如果把它直接用作 systemd/Kubernetes liveness，上游全部故障会导致一个本身健康的 balancer 被反复重启，而且每次探测都会向所有 upstream 扇出。

建议拆分：

- `/livez`：进程事件循环和 HTTP listener 正常即可。
- `/readyz`：反映 Node 配置与进程生命周期；Redis 临时故障和固定 fallback 沿用现有行为，不新增依赖故障时停止接流量的门槛。
- `/healthz`：保留为 upstream 聚合诊断，不驱动进程重启。

### 内存状态和多副本

`apps/server/src/upstream.ts:26-27` 的实例列表与 refresh Promise 是进程内状态。单 Node 进程比 Worker isolate 更稳定，但 cluster 和多个容器各有一份。持续有流量且状态存储可用时，刷新通常受 `apps/server/src/config.ts:5-6` 的 600 秒阈值影响；空闲进程不会主动刷新，刷新失败也会继续保留旧值，因此陈旧时间没有 600 秒硬上限。

这项陈旧度限制按旧版行为接受，不新增最大保留时间。无内存缓存且状态读取失败时使用固定 fallback；失败标记读取失败时按未标记失败处理，写入失败时记录 warning；定时刷新任务失败或未发现健康节点时保留旧值。迁移复用这些分支，不扩大故障期间的服务保证。

同一运行环境的多副本仍以对应 Redis 命名空间作为共享真源；定时刷新在该命名空间内必须保证单例，或者允许幂等重复并用分布式锁控制重叠。云上与云下分别维护自己的健康状态。

### 优雅退出

当前没有 Node HTTP server、SIGINT/SIGTERM、readiness 切换、活跃请求 drain、后台任务等待或 Redis close。生产入口应在收到终止信号后：

1. 标记 not-ready 并停止接受新连接。
2. 等待进行中的 HTTP 请求。
3. 等待已登记的失败标记和刷新任务，设置总退出 deadline。
4. 关闭 Redis client 后退出。

发布期间由 Worker 接管并不替代旧 Node 在途请求的收尾。Compose 停止宽限期与应用退出时限、指标最后一次 flush 的衔接，按 [云下发布方案](./origin-release-plan.md#云下退出要求)执行。

### 状态 key 放大

失败 key 包含任意公开 pathname，见 `apps/server/src/store.ts:116-119`，TTL 为 6 小时，见 `apps/server/src/config.ts:7-8`。公网随机高基数路径会放大 Redis key 数量。这是旧版已有的限制，本次保留 key 结构与 TTL，不新增限流、路径 hash 或容量告警要求；上述命名空间隔离只用于分开健康判断。

### 代理 header 与流式响应需要回归测试

当前请求把入口 `headers` 整体传给上游，见 `apps/server/src/index.ts:189-194` 和 `apps/server/src/upstream.ts:188-194,288-293`。Workers 和 Node/Undici 对 Host、Connection、Content-Length、压缩与 hop-by-hop headers 的处理并不完全相同。迁移时应显式过滤 hop-by-hop headers，并回归验证大响应、流式 body、压缩、重定向和 HEAD 行为。

## 最低改造清单

以下是让单实例 Node 版本达到“可用”而不是“偶尔能响应”的 P0 清单：

1. 抽出并导出平台无关的 Hono app/factory，保留单独 Worker wrapper。
2. 安装 `@hono/node-server`，新增 Node listener、端口/host 配置和启动脚本。
3. 增加真正的 Node build target；不要复用 Wrangler dry-run 产物。
4. 新增 Node 配置加载和启动期校验，强制使用 Redis/Redis HTTP；Node 与 Worker 的实例列表、失败标记分别读写 `origin:` 与 `worker:` 命名空间。
5. 用运行时无关的 background-task port 替换所有 `c.executionCtx` 访问。
6. 为 metrics 注入 Node 有界 buffer sink；最早的 parity smoke 可以暂时 no-op，正式承接流量前按已确认方案批量写回 Analytics Engine。
7. 把实例刷新业务与 Workers scheduled handler 拆开，并接入一个实际调度器。
8. 按已确认的同域分流方案仅在 Worker 部署前端，Node 只部署后端。
9. 增加 `/livez`、`/readyz` 和 SIGTERM graceful shutdown。

仓库统一使用 pnpm。当前 lockfile 中服务的 `@redis/client` 要求 Node 20+；完整 workspace 构建还受到 Vite、Wrangler 和 i18n 构建工具约束。为了让构建与运行环境一致，建议锁定 **Node 22.13+ 或更新的 LTS**，并在根 `package.json` 中补 `engines` 与 `packageManager`。

## 推荐实施顺序

### 阶段 1：单实例 parity smoke

- 拆 app/Worker/Node 入口。
- Redis backend（Node 使用 `origin:`，Worker 使用 `worker:`）+ no-op metrics。
- 云下反代提供 TLS，前端静态资源按已确认方案继续由 Worker 提供。
- 启动刷新 + 单例每小时刷新。
- 对照 Worker 验证 GET/HEAD、状态码、响应头和 Feed 内容。

目标：证明核心选路在 Node 上行为一致，不追求完整观测。

### 阶段 2：Node 运行生命周期

- Redis 连接生命周期适配，保持原有超时和失败行为。
- live/readiness、graceful shutdown。
- JSON 日志级别和采集。
- 验证进程退出、后台任务收尾及既有失败分支的行为一致性。

目标：补齐常驻进程的运行生命周期，不提高旧版的容错和容量保障标准。

### 阶段 3：接入已确认的指标和缓存方案

- 实现并验证已确认的 Analytics Engine 批量 ingest、费用门槛和首页连续性。
- 按已确认的 Zone Cache 方案配置普通 RSS 缓存，并验证 Worker 接管和恢复时的缓存边界。
- 直接验证云上、云下后，在 Dashboard 手动修改 Workers Routes，完成首次切换与流向核对，并保留手动回退步骤。

目标：单实例正式接流量前接通既定的数据回传与缓存，并完成手动迁移。探活 Worker、固定探活入口、自动接管专用凭据、两个切换 Actions 及自动接管演练均在首次迁移完成后另行实施；日常镜像更新演练也不作为首次迁移前提。多副本或完全去 Cloudflare 属于以后有独立需求时的评估范围，不是首版发布要求。

## 验证清单

当前仓库没有发现 `*.test.*`、`*.spec.*`、test target、Dockerfile、Compose 或 systemd 配置。迁移验证以平台适配和新旧行为一致为目标；Redis、刷新与上游故障场景只核对既有分支，不要求新增兜底。迁移前至少覆盖：

- 普通 Feed `GET`/`HEAD` 与 Worker 的 status、headers、body 对比。
- 非允许方法仍返回 405，保留路径仍按预期 404。
- `/`、实际静态资源、缺失 `/_assets/*` 和未知 Feed path 的路由优先级。
- `/healthz`、`/livez`、`/readyz` 的不同故障语义。
- Redis 空数据、慢响应、断线与恢复沿用旧版处理；Node 错误 backend 配置不会误用不存在的 KV。
- Node 并发首次访问或断线后访问只触发一次建连；建连失败后下一次操作可重新尝试，旧 client 的迟到清理不影响新 client，不重放失败或结果不明的命令。
- 同一 Redis client 上两个并发命令中，一个正常完成或超时不会立即销毁仍可用的共享连接；另一条命令在自己的原定时限内收到回复时仍可成功。连接实际断开时，未完成命令按既有失败分支结束。
- Redis 命令超时后验证发送前取消及无法确认取消两条分支，并正确消费已发送命令的迟到回复；无回复时按上述有界收尾关闭旧 client，后续操作可重新建连，迟到结果不更新已超时操作的业务状态。
- 失败标记 TTL、全 upstream 被标记失败、固定 fallback。
- Node 出口故障写入失败标记后，Worker 的完整选路仍能尝试从云上可达的上游；反向切换同样不受另一命名空间的失败标记影响。
- 两边分别刷新实例列表，只更新各自命名空间；新空间不回退读取旧共享 key。
- 共享 `/api/upstreams` 与当前运行时选路复用同一列表读取逻辑；正常、接管及恢复时，首页下一次查询分别取得 Node、Worker、Node 列表，不受 HTTP 缓存或旧接口地址影响。
- 实例刷新失败或遇到 0 个健康节点时，仍按旧版保留旧值，不新增陈旧时间上限。
- timer/job 不重叠，多副本不会重复执行。
- SIGTERM 下慢请求、后台失败标记和 Redis 连接能在 deadline 内收尾。
- 对照缓存探测范围、单次超时、顺序尝试和旁路比例，确认迁移未改变现有请求策略。
- gzip/br、流式大响应、redirect、HEAD content length 和 hop-by-hop headers。
- 在“Cloudflare 前置”和“完全直连”两种模式下分别验证真实 IP、可信 header、缓存与防火墙策略。
- request ID 能贯穿入口日志和上游请求。

## 最终建议

这个项目 **适合迁成 Node/Hono，不值得重写成另一套业务实现**。第一版应保留现有核心，只建立清晰的平台边界：

1. Node 入口与 Worker 入口并存。
2. Node 强制使用 Redis，KV 只留给 Worker adapter；云上、云下共用 Redis 时，使用独立 key 命名空间保存健康状态。
3. `waitUntil`、metrics、request metadata 和 scheduler 通过显式接口注入。
4. 静态文件、TLS 与缓存按已确认的前端和 Zone Cache 方案接入，不新增限流要求。
5. 首版使用单实例 Compose，首次迁移在 Dashboard 手动修改 Workers Routes；后续日常发布复用 Worker 临时接管，探活和切换 Actions 另行实施。多副本在以后有独立需求时再评估。

如果目标只是“在云下多跑一份后端，作为现有 Worker 的替代或旁路”，改造量属于中等，风险可控。如果目标是“完全移除 Cloudflare 且保持相同的 CDN、地理分析、指标与抗攻击能力”，主要工作会落在外围基础设施，而不是 Hono 业务代码。

## 参考资料

- [Hono：Node.js adapter、静态资源与 graceful shutdown](https://hono.dev/docs/getting-started/nodejs)
- [Cloudflare Workers：`ctx.waitUntil`](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)
- [Cloudflare Workers：Request 的 `.cf` 扩展](https://developers.cloudflare.com/workers/runtime-apis/request/#the-cf-property-requestinitcfproperties)
- [Cloudflare Workers：Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers：Static Assets bindings](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Cloudflare Analytics Engine：binding 写入与 SQL 查询](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)
- [Cloudflare Analytics Engine：SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
- [Cloudflare Cache：CDN-Cache-Control](https://developers.cloudflare.com/cache/concepts/cdn-cache-control/)
