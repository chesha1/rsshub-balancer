# 共享代码与运行时

共享运行时已完成本地实现，部署与验收进度见[实施状态](./implementation-status.md)。保留一个 `apps/server` 包、一份共享业务代码，由 Worker/Node 双入口初始化运行环境。共享模块直接导入所需函数，不反向导入入口；[路由](./README.md#路由)、[指标](./sankey-analytics-engine-ingestion-plan.md)和[缓存](./zone-cache-plan.md)分别遵循对应约定。

共享业务接口及 Worker 独有 ingest 均先于保留前缀 404 和 RSS catch-all 注册。

Worker 入口保留 [index.ts](../../apps/server/src/index.ts)，请求交给 [app.ts](../../apps/server/src/app.ts) 中的 Hono 应用，Cron 调用 `scheduled()`；Node 开发和构建均使用 [node.ts](../../apps/server/src/node.ts)，完成初始化后通过 `serve({ fetch: app.fetch, ... })` 监听，使用 `@hono/node-server` 默认的 Request/Response 实现。`app.ts` 在模块级注册路由，沿用 `types.ts` 的 Context 类型和 `routes/internal.ts` 的 Hono 子路由。两端分别调用一次 `redis.configureRedis('worker')` / `redis.configureRedis('node')`；`upstream.ts` 保留 `getUpstreams()`、`cacheInstances()`、`fetchFromUpstream()` 等普通函数和模块级缓存。两端共享 `hono/proxy` 转发，具体范围见下方 HTTP 约定。指标由入口分别调用一次 `configureMetrics('worker')` / `configureMetrics('node')` 完成初始化；`metrics.ts` 在 Node 初始化时按 `METRICS_INGEST_URL` 启用后台上传。业务统一调用 `metrics.ts` 的 `recordRouteRequestMetric()`，第一个参数为当前请求的 binding 或 `undefined`；`metrics.ts` 按入口配置调用 Worker 写入或 Node 入队函数。

## 配置与构建

- 普通配置由各模块按需读取 `process.env`；Node 在 [node.ts](../../apps/server/src/node.ts) 中直接读取入口配置，设置默认值并做基本类型转换，配置错误在实际使用时暴露。Worker vars/secrets 提供普通值，`METRICS` 对象 binding 随当前请求传入应用；Node 由容器注入环境变量，真实密钥不入库或镜像。
- 共用 pnpm 锁文件，开发、构建和本地启动任务统一由 Nx 调度。Worker 经 Wrangler 构建并包含前端，Node 通过 [vite.config.ts](../../apps/server/vite.config.ts) 将 `node.ts` 及依赖独立打包为 ESM 产物，运行时使用 `@hono/node-server`；固定监听 `0.0.0.0`，端口默认 `3000`，可通过运行时环境变量 `PORT` 覆盖。分别输出、类型检查，不能用 Worker 产物或生成类型替代 Node 构建。
- 开发、构建和运行采用 Node 26，`engines` 限定为 `>=26.8.2 <27`，容器构建和运行固定使用 26.8.2；提供 `packageManager`、Node 启动脚本及端口配置。

## Redis

两端直连同一 Redis/Valkey，业务模块通过 `import * as redis` 导入 [redis.ts](../../apps/server/src/redis.ts)，调用 `redis.getInstances()`、`redis.setInstances()`、`redis.getFailedUpstreams()`、`redis.markUpstreamFailed()`，保留 GET/SET/MGET、key 编码、JSON 和 TTL。删除 KV、Redis HTTP 实现和依赖、Wrangler KV binding、后端选择与相关配置，更新生成类型。

入口通过 `redis.configureRedis()` 设置运行环境，key 前缀与运行环境固定对应，部署只提供连接信息：

| 状态 | Node | Worker |
| --- | --- | --- |
| 实例列表 | `node:instances` | `worker:instances` |
| 失败标记 | `node:fail:<encoded-pathname>:<encoded-upstream>` | `worker:fail:<encoded-pathname>:<encoded-upstream>` |

两端各自健康检查、缓存和读写状态；失败标记不含 query，TTL 为 6 小时。启用时分别刷新列表，不读、复制或回退旧 key；切流和回滚不交换或清空状态。

## 请求内状态操作

移除状态操作的 `waitUntil` 与 `c.executionCtx` 依赖，统一 `async/await`：

- 内存列表有效时直接使用；满 600 秒等待读取，同一进程/isolate 的并发刷新共用 Promise，结束后清理。
- 非空新列表用于本次请求；失败或空结果保留旧缓存，无缓存则用固定 fallback。旧缓存没有陈旧硬上限。
- 上游失败后等待标记写入再试下一节点，写失败仅 warning；标记读失败按未标记处理。重复标记、全被标记和 fallback 沿用现状。

接受过期刷新与连续失败写入带来的额外等待，状态 I/O 使用下述超时。

## Redis 连接生命周期

Worker 使用普通 `runRedisCommand()` 函数，每命令 `connect → command → finally destroy`，不跨请求共享 socket。Node 使用独立模块中的同名函数复用进程内 client，供 HTTP 和定时刷新共用。`redis.ts` 按入口设置选择底层执行方式；Worker 不共用 Node 的连接状态机；建连与命令各限 2 秒，命令时限从提交起覆盖排队、发送及回复，禁用自动重连和离线队列。

以下连接复用及运行时命令超时恢复要求适用于 Node：

- 首次或断线后按需建连，并发共用 Promise；失败清理，由后续操作再试，本次不循环重试。处理 `error`，普通命令错误不直接判连接失效；旧回调不得清掉新 client。
- `Promise.race` 不取消底层命令。只有 SDK 确认尚未发送且已取消时，才按单命令取消。
- 已发送或无法确认的命令超时后立即走业务失败分支，client 停收新命令并消费迟到回复，迟到结果不更新业务状态。
- 其他在途命令保有原截止时间；取当时最晚截止时间作为收尾上限，全部结束或到期即关闭，不随新请求延长。期间新操作走失败分支，关闭后再按需建连；确认断连则立即清理。
- 超时、取消或断连不保证写入未执行，不补发结果不明的写命令。进程终止时不等待在途命令；Redis 中已有状态保留，原 TTL 继续生效。

## 刷新与退出

共享上游刷新函数 `scheduled()` 保留在 [scheduled.ts](../../apps/server/src/scheduled.ts)，Worker Cron、Node 启动及每小时分别调用并写各自空间。保留候选抓取、合并 fallback 和健康检查；失败或零健康节点保留旧值并 warning。列表下载含完整正文限 15 秒，使用可取消信号；其余沿用现有超时。允许轮次重叠，下载失败结束本轮，后续照常触发。

Node 在 `node.ts` 中启动 HTTP 服务和定时刷新，不注册应用层 SIGINT/SIGTERM 处理。收到信号后按 Node 默认行为直接终止，不等待在途 HTTP 响应、刷新或指标上传，也不执行退出提交。允许中断未完成请求并丢失未上传指标，客户端连接随进程终止释放。日常发布先确认 Worker 接管再更新 Node，容器信号与停止配置见[操作手册](./migration-failover-runbook.md)。

## HTTP 与验证

沿用候选、探测、顺序尝试和 fallback，`DIRECT_FALLBACK_RATE` 保持 50%；单次上游请求限 15 秒，无总 deadline，探测胜出后不主动取消其余请求。接受橙云默认 125 秒回源超时先返回 524、Node 仍在尝试的差异。[连接限制](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)

两端直接使用 `hono/proxy` 处理三处对外响应转发：RSS 顺序尝试和前置 fallback 传入 `raw` 请求，保留 GET/HEAD、手动重定向及单次 15 秒超时；`/api/route/status` 查询不透传入站请求，保留 GET、5 秒超时、默认跟随重定向和首个 200 胜出。健康检查、内部缓存探测、实例列表下载、指标上传和 SQL 查询继续使用 `fetch`。Node 入口直接交给 `app.fetch`，不再维护独立 HTTP 适配器。

请求和响应头清理由库负责，使用默认的 Connection 处理，压缩由当前运行时协商。接受 HEAD/304 的压缩编码与长度元数据可能省略，以及 Worker 可能失去压缩正文直接透传的优化；不保证运行时未知编码的透明透传。保留 RSS 状态、条件请求、缓存头和流式响应，验证 GET/HEAD、405/404、Host、压缩、重定向与失败重试。

两端直接通过 `console` 输出逐行 JSON，仅记录 warning 及以上；请求上下文只保留 Request ID、方法和路径，错误日志保留必要业务信息，不附带 runtime、layer 或地域字段，也不初始化或切换日志平台。不挂载逐请求访问日志中间件，避免为已过滤的 info 日志计时和组装字段。Node 查看 Docker logs，Worker 查看 Cloudflare Dashboard；按 Request ID 关联请求，不能靠 info 日志判断流向。

验证双目标构建、缓存/存储失败分支、状态隔离、并发建连与超时恢复、刷新及默认信号终止，确认停止进程不清空 Redis 已有状态且不触发退出上传；经公开和受控直连入口检查真实 IP、可信 header、反代及防火墙。早期 smoke 可用 no-op 指标，正式切流前必须完成指标回传。
