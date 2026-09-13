# 迁移实施状态

此前 Worker 版本已部署，用户已确认验证通过；当前 `hono/proxy` 调整仅在本地实施与验证，尚未重新部署 Worker。云下 Node 已完成本地实现与默认终止行为验证，整体 review 仍待完成，尚未部署或切换线上流量。探针、自动接管和运维控制面未实施。

## 已实施

| 范围 | 当前实现 |
| --- | --- |
| 共享业务与双入口 | Worker 入口为 `index.ts`；Node 开发和构建均使用 `node.ts`，通过 `serve()` 启动服务。两端使用 `app.ts` 中模块级创建的 Hono 应用，沿用 `types.ts` 和 `internalRoutes` 子路由。RSS、上游列表、桑基图查询、`/healthz` 与路由缓存状态查询共用业务逻辑，保留 URL。 |
| Redis | 入口调用一次 `redis.configureRedis()` 设置运行环境，业务模块导入 `redis` 模块并调用 `redis.getInstances()` / `redis.setInstances()` 等普通函数。只保留直连 Redis/Valkey；删除 KV、Redis HTTP、后端选择配置及依赖。运行环境固定对应 `node:` / `worker:` 前缀，不读取、复制或回退旧无前缀 key。失败标记保留编码和 6 小时 TTL。 |
| Redis 生命周期 | `redis.ts` 按入口设置选择并调用命令函数；Worker 按连接、执行、finally 关闭完成单次操作，Node 独立管理连接复用、并发建连与运行时超时恢复。连接与命令各限 2 秒，禁用自动重连与离线队列；不明写入不重发，Node 超时连接按原在途截止时间收尾，随后允许新操作重建。进程终止不清空 Redis 已有状态。 |
| 缓存与刷新 | `upstream.ts` 保留 `getUpstreams()`、`cacheInstances()`、`fetchFromUpstream()` 等普通函数与模块级缓存，两端分别运行，缓存自然隔离。600 秒过期后等待同一轮读取，空值或失败保留旧列表，无旧列表时使用固定 fallback。失败标记在请求内等待写入。`scheduled.ts` 的 `scheduled()` 由 Node 启动/每小时和 Worker Cron 调用，下载正文限 15 秒，零健康节点保旧。 |
| HTTP 转发 | 两端共享 `hono/proxy`，覆盖 RSS 顺序尝试、前置 50% fallback 和路由缓存状态查询；保留各自方法、重定向和超时约定，其余内部请求继续使用 `fetch`。Node 使用 `@hono/node-server` 默认 Request/Response，直接传入 `app.fetch`，删除独立 HTTP 适配器。接受的压缩与请求头差异见 [HTTP 约定](./shared-code-runtime-plan.md#http-与验证)。实时接口成功与错误响应统一添加双 `no-store`。 |
| Node 生命周期 | `node.ts` 启动先直接读取 `process.env` 中的入口配置并刷新，再监听。SIGINT/SIGTERM 使用 Node 默认终止行为，不等待在途 HTTP、刷新或指标上传；允许中断未完成请求并丢失未上传指标。 |
| 日志 | 两端直接通过 `console` 输出逐行 JSON，仅记录 warning 及以上。请求上下文只保留 Request ID、方法和路径，错误日志保留必要业务信息；去掉 runtime、layer、地域字段、日志平台切换及无输出的逐请求访问日志中间件，分别在 Docker logs、Cloudflare Dashboard 查看。 |
| 指标采集与回传 | 两端入口各调用一次 `configureMetrics()` 完成初始化，业务统一通过 `metrics.ts` 的 `recordRouteRequestMetric()` 记录。`metrics-schema.ts` 共享 v2 类型、常量和字段映射，不做指标字段或版本的运行时校验。Worker 通过 `adapters/metrics-worker.ts` 写当前请求的 binding；Node 初始化时由 `metrics.ts` 按 `METRICS_INGEST_URL` 启用后台上传，记录时调用 `nodeMetrics.recordMetric()` 入队，队列和上传状态由模块保存。Node 队列最多 2000 条，100 条或 15 秒触发，每批最多 200 条串行上传。单批通过原生 fetch 的 AbortController 限时 5 秒且只尝试一次；积压丢旧、失败丢批并汇总 warning。 |
| Worker ingest | 精确 `POST /_internal/metrics/ingest`，由 Cloudflare WAF 限制服务器公网出口 IP；应用直接解析 JSON、读取 `events`，显式传入 `origin` 并调用共享 Worker 写入函数按当前 v2 约定映射写入，所有响应双 `no-store`。Node 对此路径返回 404。 |
| 查询与必要首页适配 | 共用 Analytics Engine HTTP SQL 查询，按 `country -> outcome -> upstream` 聚合，忽略历史机房维度；同步首页类型、维度选择和中英文文案，上游列表说明来自当前承接环境。 |
| 构建与容器 | Nx 调度开发、构建和本地启动任务，Vite 构建独立 Node ESM 产物，Wrangler 构建 Worker；分别执行类型检查，共用 pnpm 锁文件。开发、构建与运行统一使用 Node 26（`>=26.8.2 <27`），容器构建和运行固定使用 26.8.2。提供 Node Dockerfile、环境变量示例和本地命令。 |

## 本地运行

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
cp apps/server/.env.example apps/server/.env
# 填写 VALKEY_URL；查询与上传按下面说明配置。
pnpm build:node
pnpm start:node
```

`pnpm dev:node` 通过 `tsx watch` 执行 [node.ts](../../apps/server/src/node.ts)，使用相同 `.env` 开发。Node 固定监听 `0.0.0.0`，端口默认 `3000`，开发和构建产物均可通过运行时环境变量 `PORT` 覆盖端口。Worker 继续使用 `pnpm dev:server` 与 `apps/server/.dev.vars`；普通配置由各模块按需读取 `process.env`，Node 在 `node.ts` 中直接读取入口配置，设置默认值并做基本类型转换，配置错误在实际使用时暴露。Worker 的 `METRICS` binding 随当前请求传入应用。

| 配置 | 使用方式 |
| --- | --- |
| `VALKEY_URL` | 两端必填，`redis://` 或 `rediss://`。前缀由入口固定，部署不提供前缀开关。 |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_ANALYTICS_API_TOKEN` | 成对配置，用于服务端 Analytics Engine 查询。缺少任一项时查询返回 500；本地可以留空，正式切流前必须配置。 |
| `METRICS_INGEST_URL` | Node 配置后启用上传；URL 必须为 HTTPS，精确以 `/_internal/metrics/ingest` 结尾，无 query/尾斜线。留空只适合本地 smoke；正式切流必须启用，ingest 由 Cloudflare WAF 限制服务器公网出口 IP。 |

`pnpm build` 通过 Nx 构建两端和首页，`pnpm build:node` 只执行 Node 构建任务，通过 [vite.config.ts](../../apps/server/vite.config.ts) 独立打包 `node.ts` 及依赖，`pnpm build:worker` 包含首页。入口产物分别为 `dist/apps/server/node/node.js` 与 `dist/apps/server/worker/index.js`。Node 26 默认通过原生语法检测识别独立产物中的 ESM，无需额外生成 `package.json`；不依赖 Worker 生成类型、Web 产物或运行时 `node_modules`。Docker 构建也执行 `pnpm build:node`，复用同一个 Nx 任务；运行容器直接通过 `node node.js` 启动服务。

```sh
docker build -f apps/server/Dockerfile -t rsshub-balancer-node:local .
docker run --rm --init --env-file apps/server/.env -p 3000:3000 rsshub-balancer-node:local
```

容器内 `VALKEY_URL` 必须能从容器网络访问。Docker 使用 `--init`，Compose 设置 `init: true`，让轻量 init 转发停止信号，避免 Node 直接作为 PID 1。首页及静态资源仍由 Worker 托管；Node 本机入口用于后端验证。

## 已完成的本地验证

- `pnpm typecheck`、`pnpm lint` 和两端构建通过。
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
