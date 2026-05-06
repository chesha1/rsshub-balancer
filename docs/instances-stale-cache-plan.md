# instances stale cache 方案

本文档描述只针对 `instances` 上游实例列表的 stale cache 方案。这个方案的目标是继续使用 Aiven Valkey 作为状态存储，同时降低请求热路径对 Redis `GET instances` 的强依赖。

## 背景

当前生产日志里频繁出现这组告警：

- `redis command timed out; falling back`
- `state store instances read failed; using fallback`

对应链路是请求进入 `fetchFromUpstream()` 后，先调用 `getUpstreams()` 读取状态存储里的 `instances`。当 `STATE_STORE_BACKEND=redis` 时，这一步会通过 `@redis/client` 向 Aiven Valkey 执行 `GET instances`。如果 Redis 命令 2000ms 内没有返回，当前代码会销毁 Redis client，抛出 `RedisCommandTimeoutError`，随后 `getUpstreams()` 捕获异常并退回 `config.fallbackUpstreams`。

这个现象不表示 Aiven Valkey 里没有数据。相反，已经观察到 Redis 中确实能正常读写数据，说明连接信息、协议和基本读写路径大体可用。真正的问题是：请求热路径要求 `GET instances` 在很短时间内稳定成功，而边缘运行环境到外部 Aiven Valkey 的 TCP/TLS Redis 命令并不总能满足这个延迟假设。

## 原因分析

### `instances` 是低频配置，不适合每次请求强读 Redis

`instances` 由定时任务刷新，变化频率很低。它更像一份低频更新的配置快照，而不是每次请求都必须实时读取的强一致状态。

现在每个需要选择上游的请求都会先读一次 `instances`。对于不同 RSS 路由，两级请求合并只能合并同一路径同方法的并发请求，不能合并大量不同路径的首次请求。因此在流量路径分散时，`GET instances` 会成为每个请求准备阶段的共同前置依赖。

### Aiven Valkey 仍然是 TCP/TLS Redis 协议

Aiven Valkey 服务通常暴露的是 Redis / Valkey protocol over TCP/TLS。当前使用的 `@redis/client` 也是 Node Redis 客户端，它依赖 socket 连接，而不是 Upstash 那类 HTTP REST Redis 客户端。

Cloudflare Workers 现在可以通过 `nodejs_compat` 使用一定的 Node socket 能力，但这不等价于传统常驻后端里的稳定长连接池。Worker isolate 和 Durable Object 的生命周期由平台管理，连接可能经历冷启动、冻结、恢复、服务端 idle timeout、跨地域网络抖动等情况。把一个模块级 Redis client 当作稳定跨请求连接复用，在边缘环境里天然比常驻后端脆弱。

### 当前超时处理会放大重连抖动

当前代码在 Redis 命令超时后会销毁共享 client。这个策略能避免继续复用疑似卡住的连接，但在高并发或外部 Redis 抖动时，可能形成这样的循环：

1. `GET instances` 超时。
2. 当前 Redis client 被销毁。
3. 后续请求重新建连。
4. 新连接或首个命令继续因为网络、冷连接或服务端延迟超时。
5. 更多请求继续销毁和重建 client。

因此失败率高时，问题不只是一次 Redis 命令慢，而是请求热路径、短超时、销毁重连和不同路由分散访问共同放大后的结果。

## 目标

本方案只解决 `instances` 读取对 Redis 的强依赖：

- Redis 正常时，继续从 Aiven Valkey 读取最新 `instances`。
- Redis 短时超时或不可用时，优先使用最近一次成功读取到的实例列表。
- 只有当前运行时没有任何可用缓存时，才退回 `config.fallbackUpstreams`。
- 避免每个请求都因为 Redis 超时额外等待 2000ms。
- 避免 Redis 抖动时把上游列表退化成单个 fallback upstream。

## 非目标

本方案暂不处理这些问题：

- 不替换 `@redis/client`。
- 不引入 `ioredis`。
- 不接入 Upstash REST Redis。
- 不实现完整 Redis circuit breaker。
- 不改变 `fail:*` 上游失败标记的读写逻辑。
- 不追求跨 isolate 或跨 Durable Object 的全局一致内存缓存。

## 方案概述

在 `upstream.ts` 中为 `instances` 增加进程内 stale cache。缓存只保存最近一次成功解析出的非空 upstream 列表，并记录更新时间和过期时间。

建议新增两个 TTL：

- `instancesFreshTtlSeconds`: 60
- `instancesStaleTtlSeconds`: 86400

fresh cache 表示缓存仍然新鲜，可以直接使用，不访问 Redis。stale cache 表示缓存已经超过 fresh TTL，但还没有超过 stale TTL。此时请求可以先使用 stale 数据，并在后台尝试刷新。

缓存是每个 Worker isolate / Durable Object 运行时本地的内存状态，不提供全局一致性。这里接受这个限制，因为 `instances` 本身是低频配置，且后端 Redis / KV 仍然是最终来源。

## 读取流程

建议把 `getUpstreams()` 改造成支持 stale cache 的流程：

1. 如果内存里有 fresh `instances`，直接返回。
2. 如果内存里有 stale `instances`：
   - 如果当前没有刷新任务在跑，启动一次后台刷新。
   - 当前请求直接返回 stale `instances`。
3. 如果内存里没有可用缓存：
   - 同步读取状态存储。
   - 读取成功且解析出非空列表时，写入内存缓存并返回。
   - 读取失败时，返回 `config.fallbackUpstreams`。
4. 如果状态存储返回空列表：
   - 沿用现有逻辑，尝试写入 `fallbackUpstreams` 作为种子。
   - 同时把 fallback 写入内存缓存，避免同一运行时持续重复种子写入。

后台刷新需要共享同一个 `refreshPromise`，避免同一个运行时里多个请求同时触发 Redis `GET instances`。刷新成功后更新缓存；刷新失败时保留旧缓存，只记录一条 warning。

## 建议接口形态

为了让请求返回后后台刷新仍有机会完成，建议给 `getUpstreams()` 增加可选参数：

```ts
type GetUpstreamsOptions = {
  waitUntil?: (promise: Promise<unknown>) => void
}
```

调用方可以把已有的 `waitUntil` 传进去：

- `fetchFromUpstream()` 已经接收 `waitUntil`，可以继续传给 `getUpstreams()`。
- Hono route 里的 `/`、`/healthz`、`/api/route/status` 可以传 `c.executionCtx.waitUntil`。
- Durable Object 里可以通过 `fetchFromUpstream()` 间接传 `this.ctx.waitUntil`。

如果某个调用点暂时没有传 `waitUntil`，也可以启动刷新 promise 并在内部捕获错误，保证不会产生未处理 rejection。只是这种情况下平台不保证响应返回后后台刷新一定完成。

## 缓存状态

建议在 `upstream.ts` 增加模块级状态：

```ts
type InstancesCache = {
  upstreams: string[]
  updatedAtMs: number
  freshUntilMs: number
  staleUntilMs: number
}
```

同时维护：

- `instancesCache: InstancesCache | undefined`
- `instancesRefreshPromise: Promise<string[] | undefined> | undefined`

判断规则：

- `now < freshUntilMs`: fresh hit
- `freshUntilMs <= now < staleUntilMs`: stale hit
- `now >= staleUntilMs`: expired，不再使用

## 日志建议

不要为每次 fresh hit 写 info 日志，否则会制造新噪音。建议只记录这些事件：

- stale cache 被使用且后台刷新启动：debug 或低频 info
- 后台刷新成功：debug 或低频 info
- 后台刷新失败但使用 stale：warning
- 无缓存且 Redis 失败后使用 fallback：warning
- 读取到空列表并 seed fallback：保留现有 warning / 行为

建议字段：

- `event: "state_store.instances_cache"`
- `outcome: "fresh_hit" | "stale_hit_refresh_started" | "refresh_succeeded" | "refresh_failed_using_stale" | "miss_failed_using_fallback"`
- `upstreamCount`
- `cacheAgeMs`
- `freshTtlSeconds`
- `staleTtlSeconds`
- `refreshDurationMs`
- `errorName`
- `error`

由于当前日志最低级别是 `info`，如果不想引入大量正常路径日志，fresh hit 可以完全不记录。

## 与现有 fallback 的关系

`config.fallbackUpstreams` 仍然保留，但语义要收窄：

- 现在：Redis `GET instances` 失败就使用 fallback。
- 改后：只有没有 fresh / stale cache，且状态存储读取失败时，才使用 fallback。

这能避免 Redis 短时抖动时把所有请求都压到单个 fallback upstream 上。

## 与定时刷新任务的关系

定时任务仍然负责从远程 RSSHub 文档拉取实例列表、做健康检查，并写入状态存储。stale cache 不取代定时任务，只是请求路径上的本地容错层。

定时任务成功写入健康实例列表后，可以顺手更新当前运行时的 `instancesCache`。这只影响执行该 cron 的运行时，不提供全局同步，但没有副作用。

## 与 `fail:*` 标记的关系

本方案不改变失败标记逻辑。请求拿到 upstream 列表后，仍然按现有逻辑读取 `fail:*` 标记，把 upstream 分为 healthy / unhealthy 两组。

如果 `fail:*` 读取失败，现有行为已经是按全健康处理。这个行为可以暂时保留，避免把多个状态存储问题混在同一次改动里。

## 风险与边界

### 缓存可能短时间过旧

stale cache 可能让某个运行时继续使用已经从状态存储中移除的 upstream。这个风险可接受，因为后续真实 fetch 仍然有失败重试和失败标记机制。

### 冷启动仍然可能 fallback

新 isolate 或新 Durable Object 运行时首次请求时没有本地缓存。如果此时 Redis 也超时，仍然会使用 `fallbackUpstreams`。stale cache 解决的是“最近成功读过之后 Redis 又抖动”的场景，不解决所有冷启动失败。

### 不是全局缓存

每个运行时都有自己的内存缓存。不同 isolate / DO 之间不会共享缓存。这符合 Workers 的运行模型，也避免引入新的全局状态组件。

### 后台刷新不能无限依赖

如果没有使用 `waitUntil`，响应返回后的后台刷新不保证完成。因此实现时应尽量让所有请求入口把 `waitUntil` 传到 `getUpstreams()`。

## 实施步骤

1. 在 `config.ts` 增加 `instancesFreshTtlSeconds` 和 `instancesStaleTtlSeconds`。
2. 在 `upstream.ts` 增加 `InstancesCache`、缓存变量和刷新 promise。
3. 把 `getUpstreams(store)` 改成 `getUpstreams(store, options?)`。
4. 实现 `readInstancesFromStore()`，专门负责从状态存储读取、解析、seed fallback 和更新缓存。
5. stale hit 时立即返回旧列表，并通过 `waitUntil` 挂起后台刷新。
6. 调整 `fetchFromUpstream()`，把已有 `waitUntil` 传给 `getUpstreams()`。
7. 调整 `/`、`/healthz`、`/api/route/status`，传入 `c.executionCtx.waitUntil`。
8. 定时任务写入健康列表后，更新当前运行时缓存。
9. 跑 `pnpm run lint`，确认格式和类型检查通过。

## 验收标准

- Redis 短时不可用时，如果运行时已有 stale cache，请求仍使用最近的完整 upstream 列表。
- Redis 短时不可用时，`state store instances read failed; using fallback` 不再按请求持续刷屏。
- stale cache 命中时，请求的 `prepareDurationMs` 不再稳定增加约 2000ms。
- 没有任何缓存且 Redis 失败时，仍能退回 `config.fallbackUpstreams`。
- `fail:*` 失败标记逻辑保持不变。
- 不引入 `npm`，不改变包管理方式。

## 后续观察

上线后重点观察：

- `state_store.instances_cache` 的 stale 使用次数和刷新失败次数。
- `state_store.redis` 中 `operation: "get instances"` 的 timeout 次数。
- `upstream.fetch` 的 `prepareDurationMs` 分布。
- `direct_upstream` 中各 upstream 的承接比例，确认 Redis 抖动时没有退化成单 fallback upstream。

如果 stale cache 后 `get instances` 超时仍然很多，但请求延迟和 fallback 退化已经消失，可以再单独评估 Redis circuit breaker。换 `ioredis` 或迁移到 HTTP Redis 客户端应作为后续独立实验，不和本方案混在一次改动里。
