# Redis

两端使用各自包中的 `@redis/client` 直连 Redis/Valkey，通过共享 [redis 模块](../packages/server-core/src/redis.ts) 读写业务状态。应用启动时调用 `configureRedis()`，固定 `node` / `worker` 命名空间和各自的 `runRedisCommand`；同一配置可重复调用，更换命名空间或执行器会报错。部署提供 `VALKEY_URL`。

共享包定义所需的命令接口和 key、JSON、TTL 规则，不导入 Redis SDK 或平台适配器。业务直接导入 redis 模块，调用 `redis.getInstances()`、`redis.setInstances()` 等操作。[Worker 实现](../apps/edge/src/redis.ts)按连接、执行、关闭完成一条命令；[Node 实现](../apps/origin/src/redis.ts)独立保存进程连接并处理运行时超时恢复，Worker 无需参与连接复用状态管理。

| 入口 | 连接生命周期 | 实例 key | 失败标记 key |
| --- | --- | --- | --- |
| Node | 每进程复用单 client，HTTP 与每小时刷新共用 | `node:instances` | `node:fail:<encoded-pathname>:<encoded-upstream>` |
| Worker | 每命令连接、执行并销毁，不跨请求共享 socket | `worker:instances` | `worker:fail:<encoded-pathname>:<encoded-upstream>` |

业务操作保留原有 `getInstances`、`setInstances`、`getFailedUpstreams`、`markUpstreamFailed`，保留 GET/SET/MGET、JSON 编码及 6 小时失败 TTL。pathname 不含 query。两端不读、复制或回退旧的无前缀 key；切流不交换或清空状态。

上游缓存及刷新 Promise 由 `upstream.ts` 模块保存，当前进程或 isolate 的 HTTP 和定时刷新共用状态；Node 与 Worker 分别运行，缓存自然隔离。600 秒过期后请求等待同一轮读取；空值或读取失败保留旧列表，无旧列表时使用固定 fallback。失败标记在请求内等待写入，写失败 warning 后继续选路，读取失败按未标记处理。`scheduled.ts` 的刷新轮次下载完整列表正文限 15 秒，零健康节点或写入失败不覆盖旧值。

两端分别限制建连和每条命令为 2 秒，禁用自动重连和离线队列。Node 并发共用建连 Promise；普通命令错误保留健康连接，确认断开后允许后续操作重建。命令时限从提交起覆盖排队、发送与回复。

超时不等于写入未执行：两端都不重发结果不明的命令。Worker 在本次操作的 `finally` 中关闭连接；Node 运行时命令超时后进入 `drain` 状态，拒绝新操作并消费迟到回复，其他在途命令保有原时限，全部完成或原最晚截止时间到期即销毁。

Node 收到终止信号后不等待 Redis 操作，客户端连接随进程终止释放。停止 Node 不会清空 Redis 中已有的实例列表和失败标记，原 TTL 继续生效；未完成的写入是否已执行可能未知，重启后重新加载和刷新本机缓存。
