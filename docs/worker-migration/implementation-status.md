# 迁移实施状态

2026-09-22 用户已删除主域名 catch-all，完成切到 Node 的路由配置。API 读回确认只保留首页、静态资源和 ingest 三条长期 Routes，均绑定 `rsshub-balancer`；RSS 和业务查询按方案回源 Node。2026-09-23 用户确认服务在线上运行良好，并已通过各类 Dashboard 完成验收。本次迁移及切流后验收按该确认完成，不再追加专项验收。

Worker 最近核对的活动版本为 `54a36e69-4eba-4516-8f75-216d1c3c201c`（该版本承接 100% Worker 流量，并非全站流量），指标 binding 为 `rsshub_balancer_request_flows`。Full (strict)、可信来源限制、ingest 白名单及 DNS／重定向／缓存配置已由用户确认完成，2026-09-23 公开桑基图查询已返回最近 24 小时的数据。独立恢复演练按用户决定不再安排；独立探活 Worker 已实现自动接管和恢复，待部署启用，维护用的接管／恢复两个手动 Actions flow 待实现。

2026-09-24 用户告知固定云下验证域名已改为 `rsshub-balancer-origin.virworks.moe`，仓库已同步 watchdog 探活地址和操作文档。下方历史检查记录中的旧域名保留当时实际值，不代表新域名已完成相同检查。

## 已实施

| 范围 | 当前实现 |
| --- | --- |
| 共享业务与双入口 | `apps/edge`、`apps/origin` 依赖 `packages/server-core`，启动时固定存储和指标实现，各自创建 Hono 应用，按公共中间件、平台专属路由、共享路由的顺序挂载。业务与定时刷新直接调用共享模块函数。RSS、上游列表、桑基图查询、`/healthz` 与路由缓存状态查询共用业务逻辑，保留 URL；ingest 由 Worker 单独注册。 |
| Redis | 两端分别调用一次 `redis.configureRedis()`，固定命名空间及本包的命令执行器；业务直接调用 `redis.getInstances()` 等模块函数。同一配置可重复调用，禁止切换命名空间或实现。保留直连 Redis/Valkey、`node:` / `worker:` 前缀、失败 key 编码和 6 小时 TTL，不读取、复制或回退旧无前缀 key。 |
| Redis 生命周期 | 各应用的 `redis.ts` 提供配置到共享 redis 模块的命令函数；Worker 按连接、执行、finally 关闭完成单次操作，Node 独立管理连接复用、并发建连与运行时超时恢复。连接与命令各限 2 秒，禁用自动重连与离线队列；不明写入不重发，Node 超时连接按原在途截止时间收尾，随后允许新操作重建。进程终止不清空 Redis 已有状态。 |
| 缓存与刷新 | `upstream.ts` 以模块变量保存缓存及并发刷新任务，当前进程或 isolate 的 HTTP 和定时刷新共用状态，两端独立。600 秒过期后等待同一轮读取，空值或失败保留旧列表，无旧列表时使用固定 fallback。失败标记在请求内等待写入。`scheduled.ts` 的 `scheduled()` 由 Node 启动/每小时和 Worker Cron 调用，下载正文限 15 秒，零健康节点保旧。 |
| HTTP 转发 | 两端共享 `hono/proxy`，覆盖 RSS 顺序尝试和路由缓存状态查询；保留各自方法、重定向和超时约定，其余内部请求继续使用 `fetch`。Node 使用 `@hono/node-server` 默认 Request/Response，直接传入 `app.fetch`，删除独立 HTTP 适配器。接受的压缩与请求头差异见 [HTTP 约定](./shared-code-runtime-plan.md#http-与验证)。实时接口成功与错误响应统一添加双 `no-store`。 |
| Node 生命周期 | `apps/origin/src/index.ts` 启动先直接读取 `process.env` 中的入口配置并刷新，再监听。SIGINT/SIGTERM 使用 Node 默认终止行为，不等待在途 HTTP、刷新或指标上传；允许中断未完成请求并丢失未上传指标。 |
| 日志 | 两端直接通过 `console` 输出逐行 JSON，仅记录 warning 及以上。请求上下文只保留 Request ID、方法和路径，错误日志保留必要业务信息；去掉 runtime、layer、地域字段、日志平台切换及无输出的逐请求访问日志中间件，分别在 Docker logs、Cloudflare Dashboard 查看。 |
| 指标采集与回传 | 共享 `metrics-schema.ts` 只定义 `country`、`upstream` 事件和批次上限；两端通过 `metrics.configureMetrics()` 固定记录函数，共享业务直接记录两个字段。Worker 仅写 `blobs: [country, upstream]`，不写 indexes、doubles、版本或占位列，请求内通过 `cloudflare:workers` 的 `env` 读取 binding。Node 包保存队列和上传状态，由启动入口按 `METRICS_INGEST_URL` 调用 `startMetricsUpload()`。队列最多 2000 条，100 条或 15 秒触发，每批最多 200 条串行上传；单批限时 5 秒且只尝试一次，积压丢旧、失败丢批并汇总 warning。 |
| Worker ingest | 精确 `POST /_internal/metrics/ingest`，由 Cloudflare WAF 限制服务器公网出口 IP；应用直接解析 `{ events }`，调用 Worker 写入函数按国家、上游两列写入，所有响应双 `no-store`。Node 对此路径返回 404。 |
| 查询与必要首页适配 | 共用 Analytics Engine HTTP SQL 查询，按 `country -> upstream` 聚合，用 `sum(_sample_interval)` 计数；首页保留维度复选框和按可见列绘图的逻辑，当前提供国家、上游两个选项，可自由勾选或取消。保留数量与悬浮提示，删除旧处理结果类型，同步中英文文案。 |
| 构建与容器 | pnpm workspace 包依赖和 Nx 任务分别归属 Worker、Node、共享包及首页。Worker 使用官方 Cloudflare Vite 插件，依赖首页构建并保留 Redis SDK 动态模块，启用 `new_module_registry`；发布使用生成的 `no_bundle` 配置。Node 由本包 Vite 配置独立打包；共享包导出源码，构建与检查缓存跟踪依赖源码。Node Dockerfile 在 `apps/origin`，开发、构建与运行统一 Node 26（`26.x`），容器使用 `node:26-bookworm-slim`，构建阶段安装 pnpm 12。 |

## 本地运行

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
cp apps/origin/.env.example apps/origin/.env
# 填写 VALKEY_URL；查询与上传按下面说明配置。
pnpm build:origin
pnpm start:origin
```

`pnpm dev:origin` 通过 `tsx watch` 执行 [origin/src/index.ts](../../apps/origin/src/index.ts)，使用相同 `.env` 开发。Node 开发和构建产物均固定监听 `0.0.0.0:3000`，容器对外入口由部署配置中的端口映射或反向代理控制。Worker 使用 `pnpm dev:edge`运行 Vite，监听 `127.0.0.1:8787`，使用 `apps/edge/.dev.vars`。Remote bindings 支持默认开启，支持的资源由 Wrangler 配置中的 `remote: true` 选择；当前 Analytics Engine 使用本地模拟，Redis 由 SDK 直连配置的地址。普通配置由各模块按需读取 `process.env`，Node 在 `apps/origin/src/index.ts` 中直接读取指标上传地址，配置错误在实际使用时暴露。Worker 的指标记录函数在请求内读取 `METRICS` binding，共享模块只保存函数引用。

| 配置 | 使用方式 |
| --- | --- |
| `VALKEY_URL` | 两端必填，`redis://` 或 `rediss://`。前缀由入口固定，部署不提供前缀开关。 |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_ANALYTICS_API_TOKEN` | 成对配置，用于服务端 Analytics Engine 查询。缺少任一项时查询返回 500；本地可以留空，正式切流前必须配置。 |
| `METRICS_INGEST_URL` | Node 配置后启用上传；URL 必须为 HTTPS，精确以 `/_internal/metrics/ingest` 结尾，无 query/尾斜线。留空只适合本地 smoke；正式切流必须启用，ingest 由 Cloudflare WAF 限制服务器公网出口 IP。 |

`pnpm build` 通过 Nx 构建 origin、edge、watchdog 和首页，`pnpm build:origin` 只执行 Node 构建任务，通过 [vite.config.ts](../../apps/origin/vite.config.ts) 独立打包 Node 入口、共享源码及依赖，`pnpm build:edge` 包含首页。入口产物分别为 `dist/apps/origin/index.js` 与 `dist/apps/edge/server/index.js`，Worker 首页位于 `dist/apps/edge/public`。`pnpm deploy` 先构建，再使用 `dist/apps/edge/server/wrangler.json` 发布，保留独立 SDK 模块。Node 26 默认通过原生语法检测识别独立产物中的 ESM，无需额外生成 `package.json`；不依赖 Worker 生成类型、Web 产物或运行时 `node_modules`。Docker 构建也执行 `pnpm build:origin`，复用同一个 Nx 任务；运行容器直接通过 `node index.js` 启动服务。

```sh
docker build -f apps/origin/Dockerfile -t rsshub-balancer-origin:local .
docker run --rm --init --env-file apps/origin/.env -p 3000:3000 rsshub-balancer-origin:local
```

容器内 `VALKEY_URL` 必须能从容器网络访问。Docker 使用 `--init`，Compose 设置 `init: true`，让轻量 init 转发停止信号，避免 Node 直接作为 PID 1。首页及静态资源仍由 Worker 托管；Node 本机入口用于后端验证。

## 已完成的本地验证

维度复选框恢复后，通过类型检查、lint 和 Worker/首页构建。实际 Element Plus 组件与 ECharts SVG 渲染验证了双列、单列和全部取消三种状态，复选框均可自由操作；单列计数正确、布局坐标有效，保留原有按可见列生成路径与聚合的逻辑。

国家、上游两字段精简通过四个项目的类型检查、lint 和 Node、Worker、首页构建。临时模拟 binding 与网络响应验证了 Worker 直接写入、Node 的 100 条批量上传、ingest 列顺序、SQL 与首页接口契约；实际 Vue 组件验证两列连线与节点计数、中英文标签、未触达上游、空数据和大量节点高度，并通过 ECharts SVG 渲染。未连接生产资源、清空数据集或部署。

共享模块 API 调整通过四个项目的类型检查、lint 和双目标构建。受控替身覆盖配置幂等与禁止切换、Redis key/TTL、并发刷新合并、HTTP 与定时刷新共享缓存、失败保旧及指标失败隔离。实际 Node 构建产物验证了启动刷新、路由响应、Redis 连接复用和指标入队上传；Worker 构建产物在本地 workerd 中验证了并发请求的当前 binding、Node 与 Worker 的指标写入、ingest 不连接 Redis、Cron 共用缓存及短连接关闭。Worker 开发模式采用整套模块重载，已验证指标、Redis 和共享上游模块变化后路由与 ingest 正常；所有检查只使用本地资源或替身，未执行部署。

Worker 开发使用 Vite，并显式启用 Remote bindings 支持，保留 `new_module_registry`。当前使用官方原始插件 `1.54.11`：其备用加载器会把 `node:process` 的正常查找未命中记为断言错误，随后 workerd 仍能解析内置实现。该上游兼容问题在不含业务依赖的空白 Worker 中也可复现，目前保留这条开发日志。

Vite 开发改动已通过四个项目的类型检查、lint、Worker/首页构建和 Wrangler 部署 dry-run。本机 Redis 替身与 HTTP 上游验证了唯一的 `dev:edge` 入口、首页及 JS 资源、有效 ingest、Redis 查询、健康检查和 `dev:web` 代理；上述启动日志未阻止服务就绪，显式导入与全局 `process.env` 的引用一致性和配置变量读取正常。临时配置和进程均已清理，未使用云端数据资源或执行线上部署。

兼容日期已更新为 `2026-09-17`，保留显式 `new_module_registry`。更新后重新生成 Worker 类型，通过类型检查、lint、Worker 构建与部署 dry-run，并使用临时本地 workerd、Redis 和 HTTP 上游验证首页、有效 ingest、Redis 查询、流式及 gzip 代理；未恢复测试文件，尚未部署线上。

独立探活 Worker 简化前的版本曾通过 34 个封闭网络测试，覆盖健康提前结束、故障接管、API 不确定结果、路由冲突和并发恢复；本地 workerd 另外通过 5 个 scheduled 场景，模拟接管只产生一次 POST，未访问线上 API。Node 与业务 Worker 的健康接口在 200／503 下均通过来源标识与禁止缓存响应验证。当时类型检查、lint 和三个应用构建通过；未部署或修改线上路由。测试文件、临时验证脚本及测试任务现已移除。

watchdog 单向接管版本只按状态码和应用标识探活，并管理约定的 catch-all。当时探活只返回健康状态和来源标识，路由查询只返回布尔值，主流程不返回日志结果对象；业务日志只记录新接管和异常。精简后通过 20 个封闭网络场景验证，覆盖健康时静默、接管日志、恢复时停止重试、已有接管路由、写入超时后读回、路由目标冲突、API 失败和公网接管结果；当时类型检查、lint 与 watchdog dry-run 构建通过。验证使用内联脚本模拟所有 fetch，未访问线上 API。

加入业务探针前的 watchdog 双向切换版本通过 40 个封闭网络场景，覆盖三次健康回切、恢复中断、按最新 ID 删除、DELETE 不确定结果、公开验证失败后重新接管、路由冲突及回退时间预算；当时通过 watchdog 类型检查、lint 和 dry-run 构建。本地 workerd 使用当时构建产物通过 6 个 scheduled 场景，另验证了重试等待的 AbortSignal 取消，共 7 项运行时检查。验证只使用临时脚本、虚拟凭证和全量出站替身，未访问线上 API 或部署；无新增仓库测试任务。

此前包含同轮回退的三分钟周期与业务探针版本通过 62 个封闭网络场景，包括健康接口正常但 Feed 失败、空 RSS、HTML 错误页、损坏或截断 XML、正文超时、跨块 UTF-8，以及慢业务请求下的回切与回退预算。正文大小上限已按用户要求移除，验证包含超过 2 MiB 的有效 RSS 完整读取；当时 watchdog 类型检查、lint 与 dry-run 构建通过。移除上限前，本地 workerd 构建产物曾通过 9 个 scheduled 场景和 1 项等待取消检查，并通过冻结锁文件安装和全仓类型检查、lint。验证只使用临时脚本、虚拟凭证和全量出站替身，未部署或修改线上路由。

2026-09-25 按用户决定将 watchdog 简化为每轮最多一次切换：未接管时检查主域名，接管时检查固定源站，修改路由并读回后结束，移除同轮回退和整轮时间预算。当时单业务探针版本通过 34 个封闭网络场景，覆盖主域名业务失败、两次确认、下一轮重新接管、最新 Route ID、POST/DELETE 不确定结果、读回失败不追加写入、来源异常，以及探测和 API 正文读取超时；watchdog 类型检查、lint 与 dry-run 构建通过。验证使用临时脚本、虚拟凭证和全量 fetch 替身，缩短计时器以验证取消行为；未新增仓库测试文件、部署或修改线上路由。

随后将业务探针配置改为 `FEED_PATHS` 数组，增加 `/github/issue/DIYgod/RSSHub`；健康接口通过后并行检查全部 Feed，全部成功才算健康，共用单次探测的 30 秒截止时间。当前版本通过 19 个隔离场景，包括第二路由失败阻止恢复或触发接管、并行启动、共享超时、失败后等待其他请求结束，以及追加第三路由；类型检查、lint 与 dry-run 构建通过。只读访问主域名的新路由返回 HTTP 200，RSS 含 58 篇有效文章；这只证明该次请求可用，未部署 watchdog 或修改线上路由。

原业务回归测试文件及测试任务已移除；以下保留删除前已经完成的验证记录。

- Redis SDK 按需加载调整后，在 Node 26.8.2 下通过 `pnpm typecheck`、`pnpm lint`、8 项回归验证、完整构建及生成配置的 Wrangler 部署 dry-run。当时使用实际分包产物、本地 workerd 和 TCP Redis 替身，验证首页可用、有效 ingest 不加载 SDK，首次并发上游查询才加载一次 SDK 并完成 `GET worker:instances`；产物静态依赖不含 Redis SDK，发布保留独立模块。Worker 类型已重新生成；未部署到线上，未测量线上启动耗时或 CPU 收益。
- 拆包后在 Node 26.8.2 下通过 `pnpm typecheck`、`pnpm lint`、7 项回归验证及 `pnpm build`；Worker 类型重新生成。当时的验证覆盖缓存隔离与并发读取、刷新与 HTTP 共用状态、代理行为、Redis key/TTL 以及两端 ingest 边界。
- 检查 Nx 依赖图和构建 source map：Node 仅依赖共享包，Worker 另依赖首页；两端产物均不包含另一端应用代码。独立 Node 产物在没有运行时 `node_modules` 的临时目录中通过启动、GET/HEAD、请求 ID、ingest 404 和 SIGTERM 检查，外部请求使用模拟响应。

下列 HTTP、信号及 Docker 检查来自拆包前的共享代理实现；后续镜像在 Oracle 的部署检查见下一节，这些历史检查不等于当前镜像的完整回归：

- `hono/proxy` 本地检查覆盖请求 ID、常见压缩、HEAD/304/302、失败重试、流式响应与超时，结果符合上述 HTTP 约定。
- SIGTERM 直接终止正在传输的流式响应，客户端收到中断；首次刷新期间收到信号也直接结束，未打开监听或写入实例列表。
- 指标达到 100 条时正常批量上传；少量事件排队时，SIGTERM 不触发退出上传。停止 Node 后 Redis 已有实例 key 保留，客户端连接随进程终止释放。
- 端口冲突时以非零状态退出。
- Docker 镜像构建及隔离网络下的 HTTP、日志、压缩响应和信号终止检查通过；启用 `--init` 后，`docker stop` 直接结束 Node，退出码为 143，无需等待强杀。

本地验证使用临时配置和模拟服务，不连接生产 Redis 或写入生产指标数据集；仍需单独完成公开入口、生产 Redis、指标账户和反代环境的验收。

## 已部署与线上验证

2026-09-21 经 Cloudflare API、公开 HTTP 和 Oracle SSH 检查，确认以下状态：

- 主域名只保留 `rsshub-balancer.virworks.moe/* -> rsshub-balancer`；12 条旧 no-script 旁路已删除，三条长期 Routes 尚未建立。主域名和固定云下域名均无 Worker Custom Domain，固定云下域名无 Worker Route。主域名仍由 Worker 承接，不因 Node 重新部署而切流。
- Worker 当前部署时间为 `2026-09-19T17:05:13Z`，活动版本如上；已核对新指标 binding、查询字段和前端。`workers.dev` 与预览入口在本轮较早检查中均为关闭。
- Node 容器于 `2026-09-21T15:40:26Z` 重新启动，状态为 running，使用 ARM64 镜像 `ghcr.io/chesha1/rsshub-balancer@sha256:674a42054c90a2f45b3fd88f6f72cb419b8e65fd76a5d08b43ed9d7ef7a9c074`，Compose 引用仍为 `latest`。`init=true`、`restart=always`，Traefik 实际 Host 规则已同时包含主域名和 `rsshub-balancer-node.virworks.moe`。
- 用户已确认在 Dashboard 完成 DNS 配置；API 登录无 DNS 读取权限，无法独立核实记录 Content。Oracle 实际公网出口仍为 `129.225.161.18`。
- 新旧 Host 经 Oracle 回环地址的 Traefik HTTPS 查询上游均返回 200；固定云下 Host 的真实 Feed GET 返回 200。此前本机健康检查、指标查询及主域名 Feed GET/HEAD 已通过。回环检查使用 `-k`，不代表 Cloudflare 回源 TLS 验收通过。
- 固定云下入口此前的 522 已不再复现。2026-09-21 15:59 UTC 通过公开 HTTPS（未使用 `-k`）验证 `https://rsshub-balancer-node.virworks.moe/openai/news`：GET/HEAD 均为 200，正文可解析为 RSS XML，包含 10 条 item；响应为 `application/xml`、`Cache-Control: public, max-age=300`、`CF-Cache-Status: DYNAMIC`。同域上游列表返回 200、7 个候选；`/healthz` 返回 200；桑基图查询返回 200、238 行数据。三个实时接口均为 `no-store`，公开 HTTPS 与后端链路已可用。此次未读回 OCI 安全规则或 Cloudflare SSL 模式，不能据此确认来源限制及 Full (strict) 配置；`DYNAMIC` 也不代表 Zone Cache 命中验收完成。
- Oracle 向主域名 ingest 提交空事件批次已从此前的 403 恢复为 204。一次本机 Node Feed 诊断请求返回 200，但其后约一分钟内三次 SQL 查询未找到该时间窗内 `country=unknown` 的新事件；不能据此确认真实指标回传落库完成，也不能仅凭短时间未查到就认定永久丢失。
- 主域名带 query 的首页仍返回 200，尚无规范化跳转；`/index.html` 返回 307 到 `/`。固定云下域名不提供首页，不能代替主域名的缓存、WAF 和切流验收。

上述 2026-09-21 检查只读并更新文档，未执行切流、重启容器或修改云端安全规则；当时未完成的安全配置核对见下方补充记录。当时回源 DNS Content 和缓存规则尚待核对，后续进展见下方切流记录。

### 2026-09-22 人工核验补充

用户确认已完成 Full (strict)、ingest 白名单及源站可信来源限制的检查，按用户人工核验结果记为通过：

- Cloudflare 对相关域名生效的 SSL/TLS 模式为 Full (strict)，固定 Node 入口可正常访问。
- ingest 的 WAF 来源白名单已核对，允许 Oracle 公网出口访问，阻断非许可来源。
- Oracle 源站的可信来源限制已核对，包括源站 Web 入口和 Node 容器端口的访问边界。

本次记录依据用户确认，未另行通过 API 或 SSH 复查，也未新增具体 HTTP 状态码或规则读回证据。当时 DNS Content 和 Zone Cache 尚待验收；按用户决定，真实 Node Feed 指标不做切流前专项验收，改为切到 Node 运行一天后通过首页观察；该次核验时主域名仍保留 Worker catch-all，尚未切流。

### 2026-09-22 长期 Routes 已创建

按用户授权通过 Cloudflare API 创建并读回以下三条 Routes，均绑定 `rsshub-balancer`：

| Pattern | Route ID |
| --- | --- |
| `rsshub-balancer.virworks.moe/` | `915f3a005ed64b7cb89b9e4f2b2d8282` |
| `rsshub-balancer.virworks.moe/_assets/*` | `464b82a5e5b24398b127f6ca046fa9ca` |
| `rsshub-balancer.virworks.moe/_internal/metrics/ingest` | `3c17f3a2bbaa4ff88eb3fc75f8feab26` |

操作前后读回确认原 catch-all `rsshub-balancer.virworks.moe/*`（ID `4bf3939f8566468d85228ad6bff3b153`）保持不变；创建完成时共四条 Routes，主域名仍由 Worker 承接，未切流。另已读取独立 Custom Domains 列表，主域名与固定 Node 域名均无相关绑定。本次未修改 DNS、重定向或缓存规则，也未发布 Worker。

### 2026-09-22 已切流与公开检查

用户确认已完成 DNS、首页重定向和缓存配置，并手动删除 catch-all。随后通过 Cloudflare API 读回：zone 仅剩上表三条长期 Routes，原 catch-all 已不存在；主域名与固定 Node 域名均无 Worker Custom Domain。DNS Content、重定向和缓存规则配置未在本次通过 API 读回，配置完成依据用户确认。

北京时间 15:29 左右通过公开 HTTPS 检查（使用 curl，未跳过证书校验）：

| 检查项 | 实际结果 |
| --- | --- |
| 首页 `/` 与抽查的一个 `/_assets/` 资源 | 均返回 200；未逐个检查所有静态资源 |
| `/?migration_check=1` | 返回 301，Location 为 `https://rsshub-balancer.virworks.moe/`，移除 query |
| `/healthz` | 200，`Cache-Control: no-store`，`CF-Cache-Status: DYNAMIC` |
| `/_internal/upstreams` | 200，JSON，`Cache-Control: no-store`，`CF-Cache-Status: DYNAMIC` |
| `/openai/news` 连续两次 GET | 均为 200，正文可解析为 RSS XML，包含 10 条 item；`Cache-Control: public, max-age=300`，两次均为 `CF-Cache-Status: HIT`，`Age` 从 83 增至 84 秒 |

健康检查 Request ID 为 `01a0c804-9b18-76c2-8575-b1714ee4acd1`，可结合时间、路径及 Traefik 日志核对（需日志已配置记录该头）。本次未读取服务器日志，不能仅凭响应认定已关联到预期 Node 容器；RSS 两次均为 HIT，未观察 MISS → HIT，也不能以缓存响应证明本次请求到达 Node。query 缓存隔离、HEAD、压缩、切流后 ingest 及 `/index.html` 重定向未在本次复测。

最初使用 Python HTTP 客户端访问首页返回 403，随后 curl 访问首页及上述资源正常；403 原因未定位，未据此认定所有客户端均已通过。此次操作只读检查，未再次修改云端配置。

### 2026-09-23 切流后指标查询

北京时间 22:15 使用 curl 只读访问公开接口 `GET https://rsshub-balancer.virworks.moe/_internal/metrics/country-colo-sankey`，未跳过证书校验，返回 200。响应的 `generatedAt` 为 `2026-09-23T14:15:41.906Z`，`windowHours` 为 24，包含 206 组国家、上游数据；各行 `value` 合计 115,775，为 `sum(_sample_interval)` 得到的加权统计，不代表包含 Cache HIT 的全站请求总量。

本次确认公开查询已有最近 24 小时的数据，未关联 Node／Traefik 日志。指标仅保存国家和上游，不含运行时来源字段，不能单凭该结果确认具体写入运行时；这是本次公开 API 查询的证据范围，整体验收结论见下方用户确认。

### 2026-09-23 用户确认验收完成及后续安排

用户确认云下服务已经在线上运行良好，并通过各类 Dashboard 完成检查。按此确认关闭本次迁移和切流后的验收，不再要求补做回源、缓存、Redis、指标等专项验收；前述 HTTP/API 检查保留为各次检查的实际记录。

用户决定不安排独立的 Node → Worker → Node 恢复演练。2026-09-24 进一步决定由独立探活 Worker 自动接管和恢复；维护时仍可停用 watchdog 后人工接管或恢复，两种方式遵循同一套 catch-all 切换约定。

## 后续工作

| 事项 | 状态与安排 |
| --- | --- |
| 迁移与线上验收 | 已完成，依据 2026-09-23 用户对线上运行及 Dashboard 核验的确认。 |
| 恢复演练 | 按用户决定不再安排，日常故障和恢复由 watchdog 自动处理。 |
| 自动接管与恢复 | `apps/watchdog` 每 3 分钟执行一次，未接管时检查主域名，接管时检查固定源站；先检查 `/healthz`，再并行检查 `FEED_PATHS` 中的 `/openai/news` 和 `/github/issue/DIYgod/RSSHub`，全部通过才算健康。同轮两次失败接管、两次健康恢复；单次完整探测共用 30 秒，重试间隔 10 秒，每轮最多修改一次路由，读回后结束，业务异常留到下一轮处理；尚未部署。部署即启用，删除 watchdog 即停用；部署前先发布两端 `/healthz` 来源标识，再配置 zone 和 Routes token，删除后重建需重新注入 token。 |
| 手动切换 | 待实现维护用的接管和恢复两个 Actions 工作流；需要保持人工选择时，先停用 watchdog 并确认在途执行结束。 |
| 发布与回滚 | 已有 [Origin image 工作流](../../.github/workflows/origin-image.yml)，GHCR ARM64 镜像已在 Oracle 运行。发布时先停用 watchdog 并手动接管，验证新 Node 后重新启用自动恢复；更新及回滚记录实际镜像 digest，使用方式见 [Origin 镜像 CI](../../README.md#origin-镜像-ci)。 |

下一步部署启用探活 Worker，并实现 Actions 手动接管／恢复流程，具体约定见[后续自动化](./migration-failover-runbook.md#后续自动化)。当前仓库只有 Node 镜像发布工作流，接管／恢复 Actions 尚未实现；探活 Worker 有独立的构建、类型生成和发布命令。
