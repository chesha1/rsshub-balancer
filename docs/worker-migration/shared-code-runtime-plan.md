# 共享代码与运行时

方案已确认，尚未实施。保留一个 `apps/server` 包、一份共享业务代码，由 Worker/Node 双入口注入平台适配。共享模块不反向导入入口；[路由](./README.md#路由)、[指标](./sankey-analytics-engine-ingestion-plan.md)和[缓存](./zone-cache-plan.md)分别遵循对应约定。

共享业务接口及 Worker 独有 ingest 均先于保留前缀 404 和 RSS catch-all 注册。

## 配置与构建

- 两端共用 `process.env` 解析校验，Node 在监听前完成必要初始化。Worker vars/secrets 提供普通值，对象 binding 留在 Worker 入口；Node 由容器注入环境变量，真实密钥不入库或镜像。
- 共用 pnpm 锁文件；Worker 经 Wrangler 构建并包含前端，Node 使用 `@hono/node-server` 和独立 ESM bundle。分别输出、类型检查，不能用 Worker 产物或生成类型替代 Node 构建。
- 构建和运行采用同一 Node 版本，最低 22.13；补齐 `engines`、`packageManager`、Node 启动脚本及 host/port 配置。

## 状态存储

两端直连同一 Redis/Valkey，共享 `RedisStateStore` 的 `getInstances`、`setInstances`、`getFailedUpstreams`、`markUpstreamFailed`，保留 GET/SET/MGET、key 编码、JSON 和 TTL。删除 KV、Redis HTTP 实现和依赖、Wrangler KV binding、后端选择与相关配置，更新生成类型。

入口固定注入前缀，部署只提供连接信息：

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

Worker 每命令 `connect → command → destroy`，不跨请求共享 socket。Node 每进程复用一个 client，供 HTTP 和定时刷新共用；建连与命令各限 2 秒，命令时限从提交起覆盖排队、发送及回复，禁用自动重连和离线队列。

- 首次或断线后按需建连，并发共用 Promise；失败清理，由后续操作再试，本次不循环重试。处理 `error`，普通命令错误不直接判连接失效；旧回调不得清掉新 client。
- `Promise.race` 不取消底层命令。只有 SDK 确认尚未发送且已取消时，才按单命令取消。
- 已发送或无法确认的命令超时后立即走业务失败分支，client 停收新命令并消费迟到回复，迟到结果不更新业务状态。
- 其他在途命令保有原截止时间；取当时最晚截止时间作为收尾上限，全部结束或到期即关闭，不随新请求延长。期间新操作走失败分支，关闭后再按需建连；确认断连则立即清理。
- 超时、取消或断连不保证写入未执行，不补发结果不明的写命令。退出收尾还受进程总时限约束。

## 刷新与退出

提取共享实例刷新函数，Worker Cron、Node 启动及每小时分别调用并写各自空间。保留候选抓取、合并 fallback 和健康检查；失败或零健康节点保留旧值并 warning。列表下载含完整正文限 15 秒，使用可取消信号；其余沿用现有超时。允许轮次重叠，下载失败结束本轮，后续照常触发。

Node 按进程管理连接、缓存、Promise、指标任务和定时器。SIGINT/SIGTERM 后在统一总时限内依次停止接收请求及定时触发，等待在途 HTTP 响应传输和已运行刷新，限时提交剩余指标，关闭 Redis；到期可终止未完成工作。容器信号与停止宽限期见[操作手册](./migration-failover-runbook.md)。

## HTTP 与验证

沿用候选、探测、顺序尝试和 fallback，`DIRECT_FALLBACK_RATE` 保持 50%；单次上游请求限 15 秒，无总 deadline，探测胜出后不主动取消其余请求。接受橙云默认 125 秒回源超时先返回 524、Node 仍在尝试的差异。[连接限制](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)

显式过滤 hop-by-hop headers；对照 Worker 验证 GET/HEAD、405/404、状态码、Host、Content-Length、压缩、重定向和流式响应。保留 JSON 日志、Request ID 和 `AsyncLocalStorage`，运行环境由入口注入；当前仅输出 warning 及以上，不能靠 info 日志判断流向。

验证双目标构建、缓存/存储失败分支、状态隔离、并发建连与超时恢复、刷新及有界退出，并经公开和受控直连入口检查真实 IP、可信 header、反代及防火墙。早期 smoke 可用 no-op 指标，正式切流前必须完成指标回传。
