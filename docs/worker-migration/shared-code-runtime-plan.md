# 共享代码与运行时

共享运行时已部署，本次线上验收已于 2026-09-23 按用户 Dashboard 核验结果完成，见[实施状态](./implementation-status.md)。后端拆为 `apps/edge`、`apps/origin` 和 `packages/server-core`；两端应用依赖共享包，分别装配平台能力，共享包不反向导入应用或适配器。[路由](./README.md#路由)、[指标](./sankey-analytics-engine-ingestion-plan.md)和[缓存](./zone-cache-plan.md)分别遵循对应约定。

共享业务接口及 Worker 独有 ingest 均先于保留前缀 404 和 RSS catch-all 注册。

Worker 入口为 [edge/src/index.ts](../../apps/edge/src/index.ts)，Node 开发和构建入口为 [origin/src/index.ts](../../apps/origin/src/index.ts)。两端各自的 `src/app.ts` 配置一次 Redis 和指标模块，创建 Hono 应用并调用 `registerCommonMiddleware(app)`，最后通过 `app.route()` 挂载共享 [routes](../../packages/server-core/src/app.ts)。Node 通过 `serve({ fetch: app.fetch, ... })` 监听，Worker 把当前请求交给 `app.fetch()`。Worker 在公共中间件之后、共享路由之前注册 ingest，保证它先于保留路径 404 和 RSS catch-all；Node 不注册 ingest。定时刷新直接调用共享 `scheduled()`。

`upstream.ts` 直接导出业务函数，模块内保存上游缓存和刷新 Promise，当前进程或 isolate 的 HTTP 与定时刷新共用状态；两端独立运行。共享模块按单应用使用，配置必须在首次业务调用前完成，之后禁止切换实现。两端共享 `hono/proxy` 转发；指标模块通过 `configureMetrics()` 保存记录函数，业务只调用 `metrics.recordRouteRequestMetric()`。Worker 的记录函数在请求中通过 `cloudflare:workers` 的 `env` 读取 `METRICS`，共享包不导入 Worker API 或保存 binding；Node 记录函数只入队。Node 入口按 `METRICS_INGEST_URL` 显式调用 `startMetricsUpload()`，导入模块本身不启动后台任务。

## 配置与构建

- 普通配置由各模块按需读取 `process.env`；Node 在 [origin/src/index.ts](../../apps/origin/src/index.ts) 中直接读取指标上传地址，配置错误在实际使用时暴露。Worker vars/secrets 提供普通值，`METRICS` 对象 binding 仅在 Worker 内处理当前请求时访问；Node 由容器注入环境变量，真实密钥不入库或镜像。
- 共用 pnpm 锁文件，开发、构建和本地启动任务统一由 Nx 调度。Worker 经官方 Cloudflare Vite 插件构建，脚本与独立 Redis SDK 模块输出到 `dist/apps/edge/server`，首页产物复制到并列的 `public/`；发布使用生成的 `server/wrangler.json`，保留 `no_bundle` 和模块规则。Node 通过 [vite.config.ts](../../apps/origin/vite.config.ts) 将 Node 入口及共享源码独立打包为 ESM 产物，运行时使用 `@hono/node-server`；固定监听 `0.0.0.0:3000`，容器对外入口由部署配置中的端口映射或反向代理控制。两端分别类型检查；Worker 独自持有生成类型和前端构建依赖。共享包使用 `workspace:*` 链接源码，由各应用打包，Nx 缓存输入包含共享包源码。
- Worker 开发时使用 Vite 的 `hotUpdate` 钩子使变更模块失效，并触发整个 Worker 模块图重载，避免局部替换平台函数后与已有的一次性配置冲突；该钩子仅用于开发，不进入构建。Node 开发继续由 `tsx watch` 重启进程。
- 开发、构建和运行采用 Node 26，`engines` 限定为 `26.x`，容器构建和运行使用 `node:26-bookworm-slim`；包管理采用 pnpm 12，Docker 构建阶段通过 `npm install --global pnpm@12` 安装。

## Redis

两端直连同一 Redis/Valkey，各自导入本包的连接实现，通过共享 [redis 模块](../../packages/server-core/src/redis.ts) 的 `configureRedis(namespace, runCommand)` 固定实现，业务直接调用 `redis.getInstances()`、`redis.setInstances()`、`redis.getFailedUpstreams()` 和 `redis.markUpstreamFailed()`。共享包只描述实际用到的 Redis 命令，不依赖 SDK，保留 GET/SET/MGET、key 编码、JSON 和 TTL。

应用装配时固定命名空间，部署只提供连接信息：

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

Worker 使用本包的 `runRedisCommand()`，每命令 `connect → command → finally destroy`，不跨请求共享 socket。Node 使用本包中的同名函数复用进程内 client，供 HTTP 和定时刷新共用。两端在启动时将命令执行器配置到共享 redis 模块，Worker 不导入 Node 的连接状态机；建连与命令各限 2 秒，命令时限从提交起覆盖排队、发送及回复，禁用自动重连和离线队列。

Worker 的 `@redis/client` 通过动态导入单独分包，首次执行 Redis 操作时才加载；`new_module_registry` 让未导入模块延后编译。ingest 不访问 Redis，因此不加载 SDK。运行时缓存的是 SDK 模块，每次命令仍创建并关闭独立连接；Node 的连接实现不受影响。`dev:edge` 由 Vite 接管，默认允许远程绑定，具体资源按 Wrangler 配置选择；代码在本机 workerd 中执行。发布产物的分包与首次查询行为已在本地 workerd 中验证，记录见[实施状态](./implementation-status.md#已完成的本地验证)。

以下连接复用及运行时命令超时恢复要求适用于 Node：

- 首次或断线后按需建连，并发共用 Promise；失败清理，由后续操作再试，本次不循环重试。处理 `error`，普通命令错误不直接判连接失效；旧回调不得清掉新 client。
- `Promise.race` 不取消底层命令。只有 SDK 确认尚未发送且已取消时，才按单命令取消。
- 已发送或无法确认的命令超时后立即走业务失败分支，client 停收新命令并消费迟到回复，迟到结果不更新业务状态。
- 其他在途命令保有原截止时间；取当时最晚截止时间作为收尾上限，全部结束或到期即关闭，不随新请求延长。期间新操作走失败分支，关闭后再按需建连；确认断连则立即清理。
- 超时、取消或断连不保证写入未执行，不补发结果不明的写命令。进程终止时不等待在途命令；Redis 中已有状态保留，原 TTL 继续生效。

## 刷新与退出

共享上游刷新函数 `scheduled()` 保留在 [scheduled.ts](../../packages/server-core/src/scheduled.ts)，Worker Cron、Node 启动及每小时分别调用并写各自空间。保留候选抓取、合并 fallback 和健康检查；失败或零健康节点保留旧值并 warning。列表下载含完整正文限 15 秒，使用可取消信号；其余沿用现有超时。允许轮次重叠，下载失败结束本轮，后续照常触发。

Node 在 `apps/origin/src/index.ts` 中启动 HTTP 服务和定时刷新，不注册应用层 SIGINT/SIGTERM 处理。收到信号后按 Node 默认行为直接终止，不等待在途 HTTP 响应、刷新或指标上传，也不执行退出提交。允许中断未完成请求并丢失未上传指标，客户端连接随进程终止释放。日常发布先确认 Worker 接管再更新 Node，容器信号与停止配置见[操作手册](./migration-failover-runbook.md)。

## HTTP 与验证

公开代理请求统一进入候选、探测、顺序尝试和 fallback 流程；单次上游请求限 15 秒，无总 deadline，探测胜出后不主动取消其余请求。接受橙云默认 125 秒回源超时先返回 524、Node 仍在尝试的差异。[连接限制](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)

两端直接使用 `hono/proxy` 处理两处对外响应转发：RSS 顺序尝试传入 `raw` 请求，保留 GET/HEAD、手动重定向及单次 15 秒超时；`/api/route/status` 查询不透传入站请求，保留 GET、5 秒超时、默认跟随重定向和首个 200 胜出。健康检查、内部缓存探测、实例列表下载、指标上传和 SQL 查询继续使用 `fetch`。Node 入口直接交给 `app.fetch`，不再维护独立 HTTP 适配器。

请求和响应头清理由库负责，使用默认的 Connection 处理，压缩由当前运行时协商。接受 HEAD/304 的压缩编码与长度元数据可能省略，以及 Worker 可能失去压缩正文直接透传的优化；不保证运行时未知编码的透明透传。保留 RSS 状态、条件请求、缓存头和流式响应，验证 GET/HEAD、405/404、Host、压缩、重定向与失败重试。

两端直接通过 `console` 输出逐行 JSON，仅记录 warning 及以上；请求上下文只保留 Request ID、方法和路径，错误日志保留必要业务信息，不附带 runtime、layer 或地域字段，也不初始化或切换日志平台。不挂载逐请求访问日志中间件，避免为已过滤的 info 日志计时和组装字段。Node 查看 Docker logs，Worker 查看 Cloudflare Dashboard；按 Request ID 关联请求，不能靠 info 日志判断流向。

后续修改运行时时，按变更范围验证双目标构建、缓存/存储失败分支、状态隔离、并发建连与超时恢复、刷新及默认信号终止，确认停止进程不清空 Redis 已有状态且不触发退出上传；涉及入口配置时检查真实 IP、可信 header、反代及防火墙。本地 smoke 可用 no-op 指标，正式环境启用指标回传。
