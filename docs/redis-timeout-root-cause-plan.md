# Redis timeout 根因定位方案

本文档描述 Redis / Aiven Valkey 超时的根因定位方案。它不是继续为某个业务命令增加 fallback，而是把 Redis 当作一个基础资源来排查：确认当前超时到底发生在建连、连接恢复、已就绪连接上的命令执行，还是 Redis 服务端本身。

## 背景

切换到 `STATE_STORE_BACKEND=redis` 后，生产日志里出现过两类相关现象：

- `redis command timed out; falling back`
- `Possible EventEmitter memory leak detected. 11 timeout listeners added to an EventEmitter. Use emitter.setMaxListeners() to increase limit`

此前的 [instances stale cache 方案](./instances-stale-cache-plan.md) 已经针对 `GET instances` 做了热路径降级：`instances` 是低频配置，不适合每个请求都同步强依赖 Redis。因此最新提交为实例列表增加了运行时内存缓存和后台刷新。上线后 `get instances` 超时 warning 已下降一半以上，说明这个方向确实降低了请求热路径对 `GET instances` 的依赖。

但 warning 仍然大约每 1-2 分钟出现一次。这说明剩余问题不应该再只按 `GET instances` 来理解。`GET instances` 只是最早、最频繁暴露问题的业务命令；真正需要确认的是：Cloudflare Worker / Durable Object 到外部 Aiven Valkey 的 Redis TCP/TLS 连接是否稳定适合作为当前项目的基础状态存储路径。

在普通常驻后端服务里，Redis 连接通常不需要这么多业务层兜底。服务进程长期运行，Redis 与应用往往同地域甚至同 VPC，连接池可以稳定复用，命令延迟也通常很低。如果在这种环境里 Redis 每隔 1-2 分钟超时一次，第一反应应该是排查 Redis 服务、网络、连接池或部署拓扑，而不是为每条命令设计复杂 fallback。

当前项目不同的地方在于：Worker / Durable Object 是边缘运行时，Aiven Valkey 是外部 TCP/TLS Redis 服务，`@redis/client` 运行在 `nodejs_compat` 提供的 Node 兼容层上。这个组合不等价于传统 Node 后端里的 Redis 长连接池。

## 现象解释

最新缓存改动后，`get instances` warning 下降一半以上，至少说明两点：

1. 原先确实有一部分超时来自请求热路径上过于频繁的 `GET instances`。
2. 剩余超时不是单靠 `instances` 缓存就能完全解释的。

剩余 warning 可能来自这些路径：

- 新 isolate 或新的 Durable Object 运行时冷启动，尚无本地 `instances` 缓存，需要首次读取状态存储。
- 缓存过刷新间隔后，后台刷新再次触发 Redis 命令。
- 请求准备阶段仍会同步读取 `fail:*` 失败标记，也就是 Redis `MGET`。
- 上游失败后，后台写入 `fail:*` 标记，也就是 Redis `SET ... EX`。
- 定时任务读取和写入 `instances`。
- Redis client 自身的异步 socket error、连接恢复或销毁重建过程。

因此后续排查需要按 Redis 生命周期和命令类型拆开，而不是只观察 `operation: "get instances"`。

## 原因分析

### Worker 的生命周期不等同于普通后端进程

普通后端进程通常会持续运行较长时间，Redis client 和连接池可以在进程内稳定复用。即使连接偶尔断开，重连也发生在一个更接近传统 Node socket 模型的环境中。

Worker isolate 和 Durable Object 的生命周期由 Cloudflare 管理。运行时可能冷启动、冻结、恢复、迁移或被回收。模块级变量可以被复用，但不能被当作普通服务器进程里的长生命周期连接池来假设。一个模块级 Redis client 在某个时刻看起来可用，不代表底层 TCP/TLS socket 在 isolate 恢复后仍然处于健康状态。

### Aiven Valkey 是外部 TCP/TLS Redis，不是边缘原生存储

Aiven Valkey 暴露的是 Redis / Valkey protocol over TCP/TLS。Worker 访问它时，不是访问 Cloudflare 内部存储，也不是普通 HTTP `fetch`，而是通过 Node 兼容层维护 TCP socket。

这条路径可能受这些因素影响：

- Worker 执行 colo 与 Aiven region 的地理距离。
- TLS 建连耗时。
- Redis 服务端 idle timeout 或网络设备回收空闲连接。
- Worker isolate 恢复后复用到半失效 socket。
- `@redis/client` 在 `nodejs_compat` 环境下的事件监听器、socket timeout 和连接状态处理差异。

如果超时主要集中在冷连接、重连或 idle 恢复后首个命令，那么根因更偏运行环境与连接模型，而不是 Redis key 或业务逻辑。

### 当前日志把不同失败压成了同一种 warning

当前 `runRedisCommandWithTimeout()` 只要命令 Promise 2000ms 内没有返回，就记录：

```text
redis command timed out; falling back
```

这条日志能说明“某条命令超过了本地预算”，但不能说明：

- 这次命令之前是否刚创建了 Redis client。
- `client.connect()` 是否耗时很长或失败。
- 命令执行时 client 是否已经 `isReady`。
- 超时发生在冷连接后的第一个命令，还是稳定连接上的普通命令。
- 超时后销毁 client 是否引发了后续重连风暴。
- EventEmitter warning 是否与某次 Redis connect / command / destroy 有时间相关性。

因此它不足以支持“一劳永逸”的基础设施判断。需要先把失败拆成更精细的生命周期事件。

### 超时后销毁 client 可能放大抖动

当前策略是在命令超时后销毁共享 Redis client。这个策略的好处是避免继续复用疑似卡住的连接；风险是如果根因本来就是冷连接或外部网络抖动，销毁会让后续请求再次经历建连和首个命令。

在高并发或多路径请求下，可能出现这样的循环：

1. 某条 Redis 命令超时。
2. 共享 client 被销毁。
3. 后续请求创建新 client。
4. 新 client 建连或首个命令再次慢。
5. 再次超时、销毁、重建。

这个循环看起来像“业务命令偶发失败”，实际可能是连接生命周期不稳定导致的抖动放大。

## 目标

- 区分 Redis 失败发生在 `connect`、`command on ready client`、`client error`、`destroy/reconnect` 哪一段。
- 按 `operation` 统计失败分布，确认剩余 warning 是否仍主要来自 `get instances`，还是来自 `mget failed upstreams`、`set failed upstream marker` 或 cron 写入。
- 按 Cloudflare colo / region 观察失败分布，确认是否与 Worker 执行位置有关。
- 关联 EventEmitter warning 与 Redis 生命周期事件，确认 listener warning 是否来自 Redis socket / `@redis/client`。
- 用观测结果决定基础设施方向：继续使用 Aiven TCP Redis、迁移到 HTTP Redis / state proxy、回退 Cloudflare 原生存储，或把服务迁到普通后端。

## 非目标

- 暂不引入 Redis command policy。
- 暂不实现 circuit breaker。
- 暂不替换 `@redis/client`。
- 暂不接入 `ioredis`。
- 暂不为了降噪直接调用 `setMaxListeners()`。
- 暂不改变 `instances` cache、`fail:*` 失败标记和上游选择逻辑的业务语义。

本方案的重点是收集足够证据，而不是继续堆应用层兜底。

## 诊断维度

### Redis connect 生命周期

需要记录每次创建 Redis client 和执行 `client.connect()` 的生命周期：

- connect started
- connect succeeded
- connect failed
- connect duration
- connect 发生时是否已有旧 client
- connect 发生原因：无 client、URL 变化、旧 client 不 ready、超时后重建

如果 timeout 与 connect started / failed 高度相关，说明主要问题是冷连接或重连。

### Redis command 生命周期

需要记录每条 Redis 命令的生命周期：

- command started
- command succeeded
- command failed
- command timed out
- operation
- durationMs
- clientGeneration
- clientReadyAtStart
- whether command is first command on this client

如果 command timeout 主要发生在刚 connect 成功后的第一条命令，问题可能是连接刚建立但实际不可用、TLS/socket 状态不稳定，或 Redis client ready 状态与 Worker socket 可用状态存在偏差。

如果 command timeout 发生在长时间稳定连接上的任意命令，需要进一步看 Redis 服务端慢日志、网络抖动或命令队列。

### Redis client 生命周期

需要为共享 client 增加轻量 generation 标识，记录：

- client created
- client ready
- client error
- client destroyed
- destroy reason
- previous generation
- next generation

这样可以判断是否存在“同一分钟内反复创建和销毁 Redis client”的重连风暴。

### Worker 请求上下文

Redis 日志需要尽量带上请求上下文：

- requestId
- cfColo
- cfCountry
- requestMethod
- requestPath 或 pathname
- Durable Object / edge layer

其中 `requestId` 已经通过 `AsyncLocalStorage` 进入日志上下文。后续可以扩展请求日志上下文，在 Hono middleware 和 Durable Object RPC 入口处写入 Cloudflare `request.cf` 里的 colo 信息。

如果 Redis timeout 集中在特定 colo，说明问题可能与 Worker 执行地到 Aiven region 的网络路径有关。

### Node warning 捕获

需要临时捕获 `process.on('warning')`，只针对 `MaxListenersExceededWarning` 记录结构化日志：

- warning name
- warning message
- warning stack
- emitter constructor name
- warning type
- listener count

如果 stack 指向 `@redis/client` 或 Node socket 相关路径，就能确认 EventEmitter warning 与 Redis client 内部连接处理相关。如果 stack 指向其它模块，再回头排查对应模块。

## 日志设计

### Redis connect 日志

建议事件：

```text
event: "state_store.redis.connect"
```

建议 outcome：

- `started`
- `succeeded`
- `failed`

建议字段：

- `clientGeneration`
- `reason`
- `durationMs`
- `isReady`
- `hasExistingClient`
- `hasConnectPromise`
- `redisUrlHash`
- `cfColo`
- `requestId`
- `errorName`
- `error`

`VALKEY_URL` 不能直接写入日志。可以只写是否配置，或写一个不可逆 hash / host 摘要。

### Redis command 日志

建议事件：

```text
event: "state_store.redis.command"
```

建议 outcome：

- `started`
- `succeeded`
- `failed`
- `timed_out`
- `skipped_not_ready`

建议字段：

- `operation`
- `durationMs`
- `timeoutMs`
- `clientGeneration`
- `clientReadyAtStart`
- `isFirstCommandOnClient`
- `commandInFlight`
- `cfColo`
- `requestId`
- `errorName`
- `error`

正常成功路径不建议长期用 `info` 全量记录，否则会制造新噪音。可以先用临时开关控制，或只记录失败和慢命令，例如 `durationMs >= 500`。

### Redis client 日志

建议事件：

```text
event: "state_store.redis.client"
```

建议 outcome：

- `created`
- `ready`
- `error`
- `destroyed`

建议字段：

- `clientGeneration`
- `reason`
- `ageMs`
- `commandCount`
- `timedOutCommandCount`
- `lastOperation`
- `lastCommandAgeMs`
- `errorName`
- `error`

### Warning 日志

建议事件：

```text
event: "runtime.warning"
```

建议 outcome：

- `max_listeners_exceeded`
- `other_warning`

建议字段：

- `warningName`
- `warningMessage`
- `warningStack`
- `emitterName`
- `warningType`
- `listenerCount`

## 实施步骤

1. 新增 Redis client generation 状态
   - 在 `store.ts` 增加 `redisClientGeneration`、`redisClientCreatedAtMs`、`redisClientCommandCount`、`redisClientTimedOutCommandCount`。
   - 每次创建 Redis client 时 generation 加一。
   - 命令日志带上当前 generation。

2. 拆分 connect 生命周期日志
   - 在 `getRedisClient()` 中记录 connect started / succeeded / failed。
   - 区分复用 ready client、等待已有 connect promise、销毁旧 client 后新建 client 三种路径。
   - connect failed 时记录 duration 和 error。

3. 拆分 command 生命周期日志
   - 在 `runRedisCommandWithTimeout()` 中记录 operation、startedAt、clientReadyAtStart、durationMs。
   - timeout 日志改成 `event: "state_store.redis.command"`、`outcome: "timed_out"`。
   - 普通失败记录 `outcome: "failed"`，成功慢命令记录 `outcome: "succeeded"` 和 `slow: true`。

4. 记录 destroy 原因
   - 把 `destroyRedisClient(client)` 改成接收 `reason`、`operation`、`clientGeneration`。
   - 超时销毁、URL 变化销毁、connect 失败清理分别记录不同 reason。

5. 扩展请求日志上下文
   - 调整 `withRequestLogContext()` 或新增更通用的上下文绑定函数，允许写入 `cfColo`、`cfCountry`、`requestMethod`、`requestPath`。
   - Hono middleware 中从 `c.req.raw.cf` 提取 colo 信息。
   - Durable Object `coalesce()` 入口从 Request header 或 request.cf 可用字段传递上下文；如果 DO 内不可直接获得完整 `cf`，至少保留 edge 层传入的 header 或 requestId。

6. 捕获 runtime warning
   - 在日志初始化模块中注册一次 `process.on('warning')`。
   - 只对 `MaxListenersExceededWarning` 写 warning 级别结构化日志。
   - 避免重复注册 handler。

7. 上线观察一个完整周期
   - 至少观察 24 小时，覆盖 cron、冷启动、低峰和高峰。
   - 如果日志量过大，保留失败、timeout、connect、destroy、runtime warning，关闭成功命令日志。

8. 根据观察结果决策
   - 如果 timeout 主要发生在 connect：优先处理部署拓扑、Redis region、HTTP state proxy 或 Cloudflare 原生存储。
   - 如果 timeout 主要发生在 ready client 的首个命令：重点排查 idle socket / isolate 恢复 / `@redis/client` 在 `nodejs_compat` 下的行为。
   - 如果 timeout 主要发生在长时间 ready client 上的随机命令：对照 Aiven 服务端慢日志、CPU、连接数、网络延迟和 Redis command latency。
   - 如果 EventEmitter warning stack 指向 Redis socket：不要用 `setMaxListeners()` 掩盖，优先减少连接 churn 或改变连接模型。

## 观察查询

### 按 operation 聚合 Redis timeout

目标：确认剩余 warning 是否仍集中在 `get instances`。

需要按以下字段聚合：

- `event = "state_store.redis.command"`
- `outcome = "timed_out"`
- `operation`
- 时间窗口

期望结果：

- 如果 `get instances` 仍占绝大多数，说明 cold cache / background refresh 仍是主要来源。
- 如果 `mget failed upstreams` 占比升高，说明请求准备阶段的失败标记读取是新主要来源。
- 如果 `set failed upstream marker` 较多，说明后台失败标记写入在 Redis 抖动时制造了额外噪音。

### 按 connect 与 command 关联

目标：判断 timeout 是否发生在建连后短时间内。

需要观察：

- `state_store.redis.connect outcome=succeeded`
- 后续同一 `clientGeneration` 的第一条 `state_store.redis.command outcome=timed_out`
- connect 到 timeout 的时间差

如果大量 timeout 发生在 connect 后几秒内，优先怀疑冷连接、TLS 或 Redis client ready 状态。

### 按 client generation 观察重连风暴

目标：判断是否存在频繁 destroy / recreate。

需要观察：

- 单位时间内 `state_store.redis.client outcome=created` 次数
- 单位时间内 `state_store.redis.client outcome=destroyed` 次数
- 每个 generation 的 `ageMs`、`commandCount`、`timedOutCommandCount`

如果 generation 生命周期很短且命令数很少，说明 Redis client 复用失败，应用正在持续冷连接。

### 按 colo 聚合

目标：判断问题是否与 Worker 执行位置有关。

需要按以下字段聚合 timeout：

- `cfColo`
- `operation`
- `clientGeneration`

如果特定 colo 明显更高，说明网络路径或地理距离是重要因素。

### 关联 EventEmitter warning

目标：确认 listener warning 是否来自 Redis client。

需要观察：

- `runtime.warning outcome=max_listeners_exceeded`
- warning stack
- 同一时间窗口内 Redis connect / destroy 次数

如果 warning 与 Redis reconnect 高度相关，并且 stack 指向 `@redis/client` 或 socket，则基本可以排除业务层 `RequestCoalescer` 的 `inflight` Map 泄漏。

## 阶段性观察结论（2026-05-08）

上线诊断日志后，已基于两批 Cloudflare Logs 导出数据做初步分析：

- `docs/logs-2026-05-08T06_25_57.894Z.json`：100 条 `event = "state_store.redis.command"` 且 `outcome = "timed_out"` 的样本，时间窗口为 `2026-05-08T06:02:40Z` 到 `2026-05-08T06:24:27Z`。
- `docs/timed_out.json` 与 `docs/http.request.json`：同一小时附近的 timeout 与入口请求样本，timeout 窗口为 `2026-05-08T05:00:04Z` 到 `2026-05-08T05:58:02Z`，入口请求窗口为 `2026-05-08T05:00:00Z` 到 `2026-05-08T05:59:59Z`。
- Cloudflare Logs 中 `event = "state_store.redis.connect"` 有 4000 多条，`outcome = "failed"` 只有 1 条；`event = "state_store.redis.client"` 有 4000 多条，其中 `outcome = "created"` 约 2000 条，`outcome = "destroyed"` 约 500 条。

### connect 不是当前主因

目前样本不支持“主要卡在 Redis connect 阶段”的判断：

- connect 日志很多，但 failed 极少。
- timeout 样本全部是 `clientReadyAtStart = true`。
- timeout 样本全部是 `isFirstCommandOnClient = false`。
- timeout 样本中的 `isReady = false` 是因为当前实现会先在 timeout handler 中销毁 client，再记录 timeout 日志；它不表示命令开始时 client 不 ready。

因此当前更像是：Redis client 已进入 ready 状态，且已经执行过若干命令后，后续命令仍可能在 2000ms 本地预算内无响应。

### command timeout 的主要来源

第一批 100 条 timeout 样本按 operation 聚合：

```text
mget failed upstreams          65
get instances                  33
set failed upstream marker      2
```

第二批 212 条 timeout 样本按 operation 聚合：

```text
mget failed upstreams          119
get instances                   90
set failed upstream marker       3
```

这说明 `instances` stale cache 已经降低了一部分热路径风险，但剩余 timeout 已经明显不只是 `get instances`。当前最主要的同步热路径风险是 DO 请求准备阶段的 `mget failed upstreams`。

### ready 连接也会在较长时间后 timeout

第一批 100 条 timeout 样本中，`readyAgeMs` 分布如下：

```text
<10s       7
10-60s    15
1-5m      38
5-15m     33
15-30m     4
>=30m      3
```

大多数 timeout 发生在 Redis client ready 超过 1 分钟之后，不集中在冷连接后的第一条命令。因此后续排查重点应放在 ready client 上的命令挂起、idle socket 恢复、Worker / Durable Object 运行时生命周期与外部 TCP/TLS Redis 的连接模型，而不是单纯扩大 connect timeout。

### cfColo 只能说明入口相关性

当前日志里的 `cfColo` 来自原始请求的 `request.cf.colo`，表示入口请求命中的 Cloudflare data center。它不一定等于 Durable Object 实际运行位置，也不一定等于 Redis TCP 连接实际出网位置。

当前代码会把带有 `cfColo` 的 Request 传给 Durable Object：

```text
edge Worker request.cf.colo -> RequestCoalescer.coalesce() 日志上下文
```

因此 `cfColo` 适合分析“哪类入口流量更容易触发 Redis timeout”，但不能直接证明“DO 就运行在这个 colo”或“Redis 出口一定来自这个 colo”。后续如果要更准确地区分 DO/runtime 位置与入口位置，需要额外增加模块级 `runtimeId`、`coalesceKeyHash` 等诊断字段，至少先判断 timeout 是否集中在少数 DO object 或 isolate/runtime 上。

### cfColo 初步结果

在 `docs/timed_out.json` 与 `docs/http.request.json` 的同一小时窗口中，全局 Redis timeout 率约为：

```text
212 / 798 = 265.66 timeout per 1000 requests
```

按 `cfColo` 聚合：

```text
AMS  70 timeout / 108 requests = 648.15 per 1000 requests
SJC  92 timeout / 371 requests = 247.98 per 1000 requests
LAX  13 timeout /  71 requests = 183.10 per 1000 requests
SEA   7 timeout /  76 requests =  92.11 per 1000 requests
YYZ   7 timeout /  29 requests = 241.38 per 1000 requests
YUL   6 timeout /  25 requests = 240.00 per 1000 requests
SOF   6 timeout /  30 requests = 200.00 per 1000 requests
```

`SJC` 的 timeout 数最多，但请求占比也最高，timeout 率略低于全局基线。`AMS` 的请求占比不高，却贡献了约三分之一 timeout，timeout 率约为全局的 2.44 倍，是当前最明显的入口相关异常点。

按 10 分钟窗口观察，`AMS` timeout 从 `05:00` 到 `05:50` 持续出现：

```text
10, 9, 12, 18, 14, 7
```

这不像单次瞬时突刺，更像一段时间内稳定偏高。`SJC` 的 timeout 数主要集中在前 20 分钟，后续明显下降，更像受当时流量分布影响。

### 暂定判断

当前阶段的根因倾向是：

- 不是 Redis connect 失败主导。
- 不是 `get instances` 单一路径主导。
- 主要风险在 DO 请求准备阶段和后台写入中，对外部 Redis 命令仍存在同步依赖。
- 外部 TCP/TLS Redis 在 Worker / Durable Object 运行模型下的 ready client 命令稳定性可疑。
- `AMS` 入口相关流量显著偏高，但还不能直接断言 DO 或 Redis 出口就在 AMS。

下一步更适合继续收集 `state_store.redis.client outcome=destroyed`、`runtime.warning outcome=max_listeners_exceeded`、慢成功命令，以及增加 `runtimeId` / `coalesceKeyHash`，再决定是调整 Durable Object location hint / Smart Placement，还是把 Redis 访问改成 HTTP state proxy。

## 决策标准

### 继续使用 Aiven Redis TCP

只有在这些条件满足时，才继续把 Aiven Redis TCP 作为主要状态存储路径：

- connect timeout 极少。
- command timeout 不集中在 cold start 或首个命令。
- client generation 生命周期稳定。
- EventEmitter warning 与 Redis client 无明显关联。
- Aiven 服务端指标显示连接数、慢日志和 CPU 都健康。

### 调整部署拓扑

如果 timeout 与 colo / region 明显相关，应优先考虑：

- 将 Aiven Valkey region 调整到主要 Worker 流量更近的位置。
- 使用 Cloudflare Smart Placement 之类能力让 Worker 更靠近 Redis。
- 把 Redis 访问移出边缘运行时，放到同 region 的普通后端服务。

### 改为 HTTP state proxy 或 HTTP Redis

如果主要问题来自 socket 生命周期、idle 恢复、`nodejs_compat` 行为或 EventEmitter warning，应考虑把 Worker 到 Redis 的路径改成 HTTP：

```text
Worker / Durable Object -> fetch HTTPS -> state proxy -> Redis connection pool -> Aiven Valkey
```

这样 Worker 只使用平台原生 `fetch`，Redis 长连接由普通后端维护。

### 回到 Cloudflare 原生状态存储

如果状态需求仍然很轻，且 Redis 主要是为了替代 KV 的摩擦，应重新评估 Cloudflare KV / Durable Object storage 是否足够。它们的优势是运行模型更贴近 Worker，不需要维护外部 TCP socket。

## 验收标准

- 能区分 Redis timeout 是 connect 阶段还是 command 阶段。
- 能按 `operation` 看出剩余 timeout 的主要来源。
- 能按 `clientGeneration` 看出是否存在重连风暴。
- 能按 `cfColo` 判断是否存在区域相关性。
- 能确认 EventEmitter warning 是否来自 Redis client / socket。
- 基于至少 24 小时数据，能明确下一步是基础设施调整、连接模型调整，还是继续在当前架构下小幅优化。

## 后续动作

完成本方案后，再根据证据选择后续方案：

- 如果根因是 Worker 到外部 TCP Redis 的连接模型，优先设计 HTTP state proxy 或迁移状态存储。
- 如果根因是 Redis region / 网络路径，优先调整部署拓扑。
- 如果根因是具体命令过重或业务调用频率过高，再回到命令级优化。
- 如果只是少量可接受的外部资源抖动，再考虑轻量 circuit breaker 和低频日志降噪。
