# 迁移实施状态

此前 Worker 版本已部署，用户已确认验证通过；当前 `hono/proxy`、包结构、共享模块 API、Redis SDK 按需加载与 Vite 开发调整仅在本地实施与验证，尚未重新部署 Worker。指标现已精简为国家、上游两列，查询和首页同步调整；本地写入配置和查询已改用新数据集 `rsshub_balancer_request_flows`，与旧格式数据隔离，尚未部署此次切换或验证云端新数据集。云下 Node 已完成本地实现与默认终止行为验证，整体 review 仍待完成，尚未部署或切换线上流量。探针、自动接管和运维控制面未实施。

## 已实施

| 范围 | 当前实现 |
| --- | --- |
| 共享业务与双入口 | `apps/worker`、`apps/node` 依赖 `packages/server-core`，启动时固定存储和指标实现，各自创建 Hono 应用，按公共中间件、平台专属路由、共享路由的顺序挂载。业务与定时刷新直接调用共享模块函数。RSS、上游列表、桑基图查询、`/healthz` 与路由缓存状态查询共用业务逻辑，保留 URL；ingest 由 Worker 单独注册。 |
| Redis | 两端分别调用一次 `redis.configureRedis()`，固定命名空间及本包的命令执行器；业务直接调用 `redis.getInstances()` 等模块函数。同一配置可重复调用，禁止切换命名空间或实现。保留直连 Redis/Valkey、`node:` / `worker:` 前缀、失败 key 编码和 6 小时 TTL，不读取、复制或回退旧无前缀 key。 |
| Redis 生命周期 | 各应用的 `redis.ts` 提供配置到共享 redis 模块的命令函数；Worker 按连接、执行、finally 关闭完成单次操作，Node 独立管理连接复用、并发建连与运行时超时恢复。连接与命令各限 2 秒，禁用自动重连与离线队列；不明写入不重发，Node 超时连接按原在途截止时间收尾，随后允许新操作重建。进程终止不清空 Redis 已有状态。 |
| 缓存与刷新 | `upstream.ts` 以模块变量保存缓存及并发刷新任务，当前进程或 isolate 的 HTTP 和定时刷新共用状态，两端独立。600 秒过期后等待同一轮读取，空值或失败保留旧列表，无旧列表时使用固定 fallback。失败标记在请求内等待写入。`scheduled.ts` 的 `scheduled()` 由 Node 启动/每小时和 Worker Cron 调用，下载正文限 15 秒，零健康节点保旧。 |
| HTTP 转发 | 两端共享 `hono/proxy`，覆盖 RSS 顺序尝试、前置 50% fallback 和路由缓存状态查询；保留各自方法、重定向和超时约定，其余内部请求继续使用 `fetch`。Node 使用 `@hono/node-server` 默认 Request/Response，直接传入 `app.fetch`，删除独立 HTTP 适配器。接受的压缩与请求头差异见 [HTTP 约定](./shared-code-runtime-plan.md#http-与验证)。实时接口成功与错误响应统一添加双 `no-store`。 |
| Node 生命周期 | `apps/node/src/index.ts` 启动先直接读取 `process.env` 中的入口配置并刷新，再监听。SIGINT/SIGTERM 使用 Node 默认终止行为，不等待在途 HTTP、刷新或指标上传；允许中断未完成请求并丢失未上传指标。 |
| 日志 | 两端直接通过 `console` 输出逐行 JSON，仅记录 warning 及以上。请求上下文只保留 Request ID、方法和路径，错误日志保留必要业务信息；去掉 runtime、layer、地域字段、日志平台切换及无输出的逐请求访问日志中间件，分别在 Docker logs、Cloudflare Dashboard 查看。 |
| 指标采集与回传 | 共享 `metrics-schema.ts` 只定义 `country`、`upstream` 事件和批次上限；两端通过 `metrics.configureMetrics()` 固定记录函数，共享业务直接记录两个字段。Worker 仅写 `blobs: [country, upstream]`，不写 indexes、doubles、版本或占位列，请求内通过 `cloudflare:workers` 的 `env` 读取 binding。Node 包保存队列和上传状态，由启动入口按 `METRICS_INGEST_URL` 调用 `startMetricsUpload()`。队列最多 2000 条，100 条或 15 秒触发，每批最多 200 条串行上传；单批限时 5 秒且只尝试一次，积压丢旧、失败丢批并汇总 warning。 |
| Worker ingest | 精确 `POST /_internal/metrics/ingest`，由 Cloudflare WAF 限制服务器公网出口 IP；应用直接解析 `{ events }`，调用 Worker 写入函数按国家、上游两列写入，所有响应双 `no-store`。Node 对此路径返回 404。 |
| 查询与必要首页适配 | 共用 Analytics Engine HTTP SQL 查询，按 `country -> upstream` 聚合，用 `sum(_sample_interval)` 计数；首页保留维度复选框和按可见列绘图的逻辑，当前提供国家、上游两个选项，可自由勾选或取消。保留数量与悬浮提示，删除旧处理结果类型，同步中英文文案。 |
| 构建与容器 | pnpm workspace 包依赖和 Nx 任务分别归属 Worker、Node、共享包及首页。Worker 使用官方 Cloudflare Vite 插件，依赖首页构建并保留 Redis SDK 动态模块，启用 `new_module_registry`；发布使用生成的 `no_bundle` 配置。Node 由本包 Vite 配置独立打包；共享包导出源码，构建与检查缓存跟踪依赖源码。Node Dockerfile 在 `apps/node`，开发、构建与运行统一 Node 26（`>=26.8.2 <27`），容器固定 26.8.2。 |

## 本地运行

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
cp apps/node/.env.example apps/node/.env
# 填写 VALKEY_URL；查询与上传按下面说明配置。
pnpm build:node
pnpm start:node
```

`pnpm dev:node` 通过 `tsx watch` 执行 [node/src/index.ts](../../apps/node/src/index.ts)，使用相同 `.env` 开发。Node 固定监听 `0.0.0.0`，端口默认 `3000`，开发和构建产物均可通过运行时环境变量 `PORT` 覆盖端口。Worker 使用 `pnpm dev:worker`（保留 `dev:server` 别名）运行 Vite，监听 `127.0.0.1:8787`，使用 `apps/worker/.dev.vars`。Remote bindings 支持默认开启，支持的资源由 Wrangler 配置中的 `remote: true` 选择；当前 Analytics Engine 使用本地模拟，Redis 由 SDK 直连配置的地址。普通配置由各模块按需读取 `process.env`，Node 在 `apps/node/src/index.ts` 中直接读取入口配置，设置默认值并做基本类型转换，配置错误在实际使用时暴露。Worker 的指标记录函数在请求内读取 `METRICS` binding，共享模块只保存函数引用。

| 配置 | 使用方式 |
| --- | --- |
| `VALKEY_URL` | 两端必填，`redis://` 或 `rediss://`。前缀由入口固定，部署不提供前缀开关。 |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_ANALYTICS_API_TOKEN` | 成对配置，用于服务端 Analytics Engine 查询。缺少任一项时查询返回 500；本地可以留空，正式切流前必须配置。 |
| `METRICS_INGEST_URL` | Node 配置后启用上传；URL 必须为 HTTPS，精确以 `/_internal/metrics/ingest` 结尾，无 query/尾斜线。留空只适合本地 smoke；正式切流必须启用，ingest 由 Cloudflare WAF 限制服务器公网出口 IP。 |

`pnpm build` 通过 Nx 构建两端和首页，`pnpm build:node` 只执行 Node 构建任务，通过 [vite.config.ts](../../apps/node/vite.config.ts) 独立打包 Node 入口、共享源码及依赖，`pnpm build:worker` 包含首页。入口产物分别为 `dist/apps/node/node.js` 与 `dist/apps/worker/server/index.js`，Worker 首页位于 `dist/apps/worker/public`。`pnpm deploy` 先构建，再使用 `dist/apps/worker/server/wrangler.json` 发布，保留独立 SDK 模块。Node 26 默认通过原生语法检测识别独立产物中的 ESM，无需额外生成 `package.json`；不依赖 Worker 生成类型、Web 产物或运行时 `node_modules`。Docker 构建也执行 `pnpm build:node`，复用同一个 Nx 任务；运行容器直接通过 `node node.js` 启动服务。

```sh
docker build -f apps/node/Dockerfile -t rsshub-balancer-node:local .
docker run --rm --init --env-file apps/node/.env -p 3000:3000 rsshub-balancer-node:local
```

容器内 `VALKEY_URL` 必须能从容器网络访问。Docker 使用 `--init`，Compose 设置 `init: true`，让轻量 init 转发停止信号，避免 Node 直接作为 PID 1。首页及静态资源仍由 Worker 托管；Node 本机入口用于后端验证。

## 已完成的本地验证

维度复选框恢复后，通过类型检查、lint 和 Worker/首页构建。实际 Element Plus 组件与 ECharts SVG 渲染验证了双列、单列和全部取消三种状态，复选框均可自由操作；单列计数正确、布局坐标有效，保留原有按可见列生成路径与聚合的逻辑。

国家、上游两字段精简通过四个项目的类型检查、lint 和 Node、Worker、首页构建。临时模拟 binding 与网络响应验证了 Worker 直接写入、Node 的 100 条批量上传、ingest 列顺序、SQL 与首页接口契约；实际 Vue 组件验证两列连线与节点计数、中英文标签、未触达上游、空数据和大量节点高度，并通过 ECharts SVG 渲染。未连接生产资源、清空数据集或部署。

共享模块 API 调整通过四个项目的类型检查、lint 和双目标构建。受控替身覆盖配置幂等与禁止切换、Redis key/TTL、并发刷新合并、HTTP 与定时刷新共享缓存、失败保旧及指标失败隔离。实际 Node 构建产物验证了启动刷新、路由响应、Redis 连接复用和指标入队上传；Worker 构建产物在本地 workerd 中验证了并发请求的当前 binding、Node 与 Worker 的指标写入、ingest 不连接 Redis、Cron 共用缓存及短连接关闭。Worker 开发模式采用整套模块重载，已验证指标、Redis 和共享上游模块变化后路由与 ingest 正常；所有检查只使用本地资源或替身，未执行部署。

Worker 开发使用 Vite，并显式启用 Remote bindings 支持，保留 `new_module_registry`。当前使用官方原始插件 `1.54.11`：其备用加载器会把 `node:process` 的正常查找未命中记为断言错误，随后 workerd 仍能解析内置实现。该上游兼容问题在不含业务依赖的空白 Worker 中也可复现，目前保留这条开发日志。

Vite 开发改动已通过四个项目的类型检查、lint、Worker/首页构建和 Wrangler 部署 dry-run。本机 Redis 替身与 HTTP 上游验证了唯一的 `dev:worker` 入口、首页及 JS 资源、有效 ingest、Redis 查询、健康检查和 `dev:web` 代理；上述启动日志未阻止服务就绪，显式导入与全局 `process.env` 的引用一致性和配置变量读取正常。临时配置和进程均已清理，未使用云端数据资源或执行线上部署。

兼容日期已更新为 `2026-09-17`，保留显式 `new_module_registry`。更新后重新生成 Worker 类型，通过类型检查、lint、Worker 构建与部署 dry-run，并使用临时本地 workerd、Redis 和 HTTP 上游验证首页、有效 ingest、Redis 查询、流式及 gzip 代理；未恢复测试文件，尚未部署线上。

测试文件及测试任务现已移除；以下保留删除前已经完成的验证记录。

- Redis SDK 按需加载调整后，在 Node 26.8.2 下通过 `pnpm typecheck`、`pnpm lint`、8 项回归验证、完整构建及生成配置的 Wrangler 部署 dry-run。当时使用实际分包产物、本地 workerd 和 TCP Redis 替身，验证首页可用、有效 ingest 不加载 SDK，首次并发上游查询才加载一次 SDK 并完成 `GET worker:instances`；产物静态依赖不含 Redis SDK，发布保留独立模块。Worker 类型已重新生成；未部署到线上，未测量线上启动耗时或 CPU 收益。
- 拆包后在 Node 26.8.2 下通过 `pnpm typecheck`、`pnpm lint`、7 项回归验证及 `pnpm build`；Worker 类型重新生成。当时的验证覆盖缓存隔离与并发读取、刷新与 HTTP 共用状态、代理行为、Redis key/TTL 以及两端 ingest 边界。
- 检查 Nx 依赖图和构建 source map：Node 仅依赖共享包，Worker 另依赖首页；两端产物均不包含另一端应用代码。独立 Node 产物在没有运行时 `node_modules` 的临时目录中通过启动、GET/HEAD、请求 ID、ingest 404 和 SIGTERM 检查，外部请求使用模拟响应。

下列 HTTP、信号及 Docker 检查来自拆包前的共享代理实现；本次环境未安装 Docker，迁移后的 Dockerfile 尚未重新构建镜像：

- `hono/proxy` 本地检查覆盖请求 ID、常见压缩、HEAD/304/302、失败重试、流式响应与超时，结果符合上述 HTTP 约定。
- SIGTERM 直接终止正在传输的流式响应，客户端收到中断；首次刷新期间收到信号也直接结束，未打开监听或写入实例列表。
- 指标达到 100 条时正常批量上传；少量事件排队时，SIGTERM 不触发退出上传。停止 Node 后 Redis 已有实例 key 保留，客户端连接随进程终止释放。
- 端口冲突时以非零状态退出。
- Docker 镜像构建及隔离网络下的 HTTP、日志、压缩响应和信号终止检查通过；启用 `--init` 后，`docker stop` 直接结束 Node，退出码为 143，无需等待强杀。

本地验证使用临时配置和模拟服务，不连接生产 Redis 或写入生产指标数据集；仍需单独完成公开入口、生产 Redis、指标账户和反代环境的验收。

## 尚未实施或执行

| 待办 | 后续工作 |
| --- | --- |
| Node review | 整体 review 仍待完成：确认云下 Node 入口与配置、共享代理、Redis 长连接、指标上传及进程退出逻辑。通过后再准备服务器部署与切流。 |
| 发布流水线 | 镜像构建/推送 GitHub Actions、版本镜像保留与发布操作尚未接入。本次只有本地 Dockerfile 和构建验证。 |
| 服务器部署 | `my-servers` 中的 Compose（含 `init: true`）、Traefik、TLS、运行时密钥、可信来源/防火墙及容器停止宽限期尚未配置。Node 尚未部署。 |
| 线上状态初始化 | Node 首次启用需刷新自身命名空间；生产 Redis 的实际连接数、断线/超时和双端独立读写仍待专项验收。旧 key 不迁移或清空。 |
| Node 指标回传 | ingest 的 Cloudflare WAF 来源规则已由用户配置；Node 上传 URL、查询凭据、账户计划、实际流量和 Analytics Engine 额度，以及真实 Node → Worker → 数据集回传与查询仍待验收。 |
| 域名与手动切流 | 尚未读取/备份或修改线上 Routes、Custom Domains、DNS、首页重定向；三条长期 Routes、catch-all 接管和恢复均未操作。 |
| Zone Cache | 双 `no-store` 已写入代码；Dashboard Cache Rule、规则冲突检查及真实 MISS/HIT/query 行为尚未配置或验收。 |
| 公开验收与回滚演练 | 尚未执行 Node → Worker → Node 的三态切换，未验证公开入口真实流向、压缩、日志关联、缓存及旧版本恢复。按[操作手册](./migration-failover-runbook.md)执行。 |
| 探针和自动接管 | 按本次要求暂不实施：不新增探活 Worker、健康检查接口、固定探活域名、切换 Actions 或 DO。 |

下一步先 review 云下 Node 部分；通过后准备服务器部署与运行配置、完成真实指标回传，再按操作手册手动切流。探针和自动化继续独立后置。
