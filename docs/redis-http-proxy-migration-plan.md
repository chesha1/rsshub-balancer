# Redis HTTP proxy 迁移计划

本文档记录当前 Redis / Aiven Valkey 超时现状、最新日志证据，以及接下来部署 Serverless Redis HTTP proxy 并在 Worker 侧改用 `@upstash/redis` 的实施计划。

本方案不再以调整 Redis 命令等待时间作为优化方向；当前代码里的超时配置以仓库现状为准。

## 背景

当前生产状态存储使用 `STATE_STORE_BACKEND=redis`，Worker 通过 `@redis/client` 和 `nodejs_compat` 直接连接外部 Aiven Valkey。这个模型在普通常驻 Node 服务里比较自然，但在 Cloudflare Workers / Edge runtime 中会遇到更脆弱的连接生命周期：

- Worker isolate 可能冷启动、冻结、恢复或回收。
- 模块级 Redis client 可以跨请求复用，但不能等同于传统后端进程里的稳定连接池。
- Aiven Valkey 是外部 TCP/TLS Redis，不是 Cloudflare 原生 HTTP 存储。
- 当前 Redis client 是多个业务路径共享的模块级 client，某条命令超时后会销毁共享 client。

近期已经把 Durable Object 参与比例降到 `DO_SAMPLE_RATE = 0.01`，绝大多数请求直接在 edge 层访问上游。新日志仍然显示 Redis 命令 timeout 和 `Disconnects client`，说明问题不再主要是 Durable Object 压力，而是 Worker 到外部 TCP Redis 的连接模型本身不稳定。

拟采用的方向是：

```text
Cloudflare Worker
        |
        | HTTPS fetch, @upstash/redis
        v
Serverless Redis HTTP proxy
        |
        | Redis TCP/TLS connection pool
        v
Aiven Valkey
```

也就是让 Worker 不再维护 Redis TCP client，而是通过 HTTP 调用代理。代理部署在更接近 Aiven Valkey 的区域，负责维护 Redis 连接池。

## 日志样本

### `logs-2026-05-08T10_38_27.581Z.json`

这份日志使用 `outcome = "timed_out"` 过滤，一小时窗口内共 422 条 Redis command timeout：

| operation | 数量 | 占比 |
| --- | ---: | ---: |
| `mget failed upstreams` | 224 | 53.1% |
| `get instances` | 105 | 24.9% |
| `set failed upstream marker` | 93 | 22.0% |

关键现象：

- 全部日志都是 `event = "state_store.redis.command"`、`outcome = "timed_out"`。
- 全部发生在 `layer = "edge"`。
- 全部在命令开始时 `clientReadyAtStart = true`。
- 388 条不是该 client 上的第一条命令，34 条是第一条命令。
- `commandInFlight` p95 为 14，最大 32，说明当时存在一定并发堆积。
- `AMS` 贡献 210 条 timeout，是这一小时最突出的入口 colo。

这说明 DO 降压之后，Redis timeout 仍然广泛出现在 edge 请求路径，且主要已经转移到 `mget failed upstreams`。

### `logs-2026-05-08T14_41_36.278Z.json`

这份日志同样使用 `outcome = "timed_out"` 过滤，一小时窗口内共 172 条 Redis command timeout：

| operation | 数量 | 占比 |
| --- | ---: | ---: |
| `mget failed upstreams` | 116 | 67.4% |
| `get instances` | 52 | 30.2% |
| `set failed upstream marker` | 4 | 2.3% |

关键现象：

- 全部发生在 `layer = "edge"`。
- 全部在命令开始时 `clientReadyAtStart = true`。
- 全部都不是该 client 上的第一条命令。
- `commandInFlight` p95 为 2，最大 7，并发堆积明显低于上一份日志。
- `set failed upstream marker` 的 timeout 大幅下降，剩余主要是 `mget failed upstreams` 和 `get instances`。

这说明问题不只是高并发下的本地排队。即使命令并发不高，ready client 上的 Redis 命令仍会挂起并触发 timeout。

### `logs-2026-05-08T14_49_05.789Z.json`

这份日志使用 `event = "state_store.redis.command"` 过滤，所以同时包含 timeout、失败和慢成功。一小时窗口内共 254 条 Redis command 日志：

| outcome | 数量 | 说明 |
| --- | ---: | --- |
| `timed_out` | 174 | 命令本地等待超时，随后 fallback |
| `failed` | 64 | 命令失败，错误均为 `Error: Disconnects client` |
| `succeeded` | 16 | 慢命令成功，全部是 `set failed upstream marker` |

按 operation 和 outcome 拆分：

| outcome / operation | 数量 |
| --- | ---: |
| `timed_out / mget failed upstreams` | 117 |
| `failed / mget failed upstreams` | 53 |
| `timed_out / get instances` | 53 |
| `succeeded / set failed upstream marker` | 16 |
| `failed / set failed upstream marker` | 11 |
| `timed_out / set failed upstream marker` | 4 |

关键报错：

```text
redis command timed out; falling back
RedisCommandTimeoutError: redis mget failed upstreams command timed out
RedisCommandTimeoutError: redis get instances command timed out
RedisCommandTimeoutError: redis set failed upstream marker command timed out
```

```text
redis command failed
Error: Disconnects client
```

更重要的是请求级关联：

- 共 183 个 requestId。
- 50 个 requestId 同时出现 `get instances` timeout 和 `mget failed upstreams` 的 `Disconnects client`。
- 最常见单条模式是 `timed_out:mget failed upstreams`，共 113 个 requestId。
- 第二常见模式是 `failed:mget failed upstreams:Disconnects client | timed_out:get instances`，共 45 个 requestId。

这说明当前共享 Redis client 有明显的连带失败：一个后台或并行的 `get instances` timeout 会触发 `destroyRedisClient()`，同一个 client 上正在执行的 `mget failed upstreams` 随后失败为 `Error: Disconnects client`。

另外，16 条慢成功全部是 `set failed upstream marker`，耗时约 501-571ms；没有看到 `get instances` 或 `mget failed upstreams` 在慢成功区间恢复。这进一步说明主要瓶颈不是某些命令只是略慢，而是 GET/MGET 这类读命令会直接进入挂起或断连路径。

## 当前判断

当前问题有两层：

1. 外部 TCP/TLS Redis 连接在 Workers edge runtime 中不够稳定。timeout 发生在 ready client 上，并且不是只发生在第一条命令。
2. 应用层共享 Redis client 会放大故障。一个命令 timeout 后销毁 client，会让同 client 上其它正在执行的命令变成 `Disconnects client`。

`instances` stale cache 已经降低了 `GET instances` 的热路径影响，Durable Object 降采样也降低了 DO 压力，但 `mget failed upstreams` 仍然是请求准备阶段的同步 Redis 读。只要 Worker 继续直接维护 Redis TCP client，请求热路径仍会暴露在这个连接模型下。

因此下一步重点不是继续给每条 Redis 命令加更多业务 fallback，而是把 Worker 到 Redis 的通信改成 HTTP，把 Redis TCP 连接池移出 Worker runtime。

## 目标

- Worker 侧改用 `@upstash/redis`，通过 HTTP 访问 Redis proxy。
- Redis proxy 侧继续连接现有 Aiven Valkey，不做数据迁移。
- 保持现有业务 key 不变：`instances` 和 `fail:{upstream}:{pathname}`。
- 保持现有状态存储接口语义不变：`getInstances()`、`setInstances()`、`getFailedUpstreams()`、`markUpstreamFailed()`。
- 通过环境变量切换后端，保留回滚到当前 direct Redis 的能力。
- 上线后用相同日志过滤条件验证 `timed_out` 和 `Disconnects client` 是否消失或显著下降。

## 非目标

- 不自研完整 Redis HTTP proxy。
- 不把 Aiven Valkey 数据迁移到 Upstash 托管 Redis。
- 不改变 upstream 选择、失败标记 TTL 或 instances cache 业务语义。
- 不在这一轮处理完整 Redis command policy、circuit breaker 或多租户代理产品化。

## 代理部署方案

先部署 `hiett/serverless-redis-http`。SRH 的目标是兼容 `@upstash/redis` 的 HTTP body 调用方式，并通过连接池连接后端 Redis。

建议部署形态：

```text
Docker host, same region or near region as Aiven
  - Caddy: public HTTPS
  - SRH: internal HTTP
  - Aiven Valkey: rediss://...
```

SRH 环境变量：

| 变量 | 说明 |
| --- | --- |
| `SRH_MODE=env` | 单 Redis 后端配置模式 |
| `SRH_TOKEN` | Worker 调用 proxy 时使用的 bearer token |
| `SRH_CONNECTION_STRING` | Aiven Valkey 连接串，建议使用 `rediss://...` |
| `SRH_MAX_CONNECTIONS` | SRH 到 Redis 的连接池大小，先从 3 开始 |
| `SRH_PORT=80` | SRH 容器内监听端口 |

部署注意事项：

- proxy 必须通过 HTTPS 暴露给 Worker。
- `SRH_TOKEN` 使用长随机值，并通过 Worker secret 保存。
- SRH 应尽量部署在 Aiven Valkey 同 region 或网络延迟最低的 region。
- SRH 不要裸露后端 Redis 连接串，也不要把 Redis TCP 端口暴露到公网。
- 先单实例部署验证，再考虑健康检查、自动重启、监控和多副本。

## Worker 改造计划

### 1. 安装 HTTP Redis SDK

使用仓库约定的包管理器：

```bash
pnpm add @upstash/redis
```

### 2. 增加新的状态存储后端

建议不要把 SRH backend 命名为 `upstash`，因为实际后端仍然是 Aiven Valkey。更清晰的命名是：

```text
STATE_STORE_BACKEND=redis-http
```

新增 Worker 环境变量：

```text
REDIS_HTTP_URL=https://redis-proxy.example.com
REDIS_HTTP_TOKEN=<same value as SRH_TOKEN>
```

也可以后续再兼容 Upstash 官方环境变量：

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

### 3. 实现 `RedisHttpStateStore`

在 `src/store.ts` 中保留现有 `KvStateStore` 和 `RedisStateStore`，新增 `RedisHttpStateStore`：

- `getInstances()` 调用 HTTP Redis `GET instances`。
- `setInstances()` 调用 HTTP Redis `SET instances <json>`。
- `getFailedUpstreams()` 对 fail keys 调用 HTTP Redis `MGET`。
- `markUpstreamFailed()` 调用 HTTP Redis `SET key 1 EX ttlSeconds`。

这个后端只替换传输层，不改变 key、value 或 TTL 语义。

### 4. 增加后端选择

把 `StateStoreBackend` 扩展为：

```ts
type StateStoreBackend = 'kv' | 'redis' | 'redis-http'
```

`createStateStore()` 按环境变量选择：

```text
redis      -> 当前 @redis/client 直连 Aiven Valkey
redis-http -> @upstash/redis 访问 SRH
kv         -> Cloudflare KV 回滚后端
```

### 5. 日志与观测

新增 HTTP Redis 后端时，建议继续保留结构化日志，但用新的事件名区分：

```text
event = "state_store.redis_http.command"
```

建议至少记录：

- `operation`
- `outcome`
- `durationMs`
- `statusCode` 或 SDK error
- `requestId`
- `cfColo`
- `layer`

上线后重点看：

- 是否还出现 `Error: Disconnects client`。
- `mget failed upstreams` 是否仍然大量 timeout。
- Worker `$workers.outcome = "canceled"` 是否下降。
- `prepareDurationMs` 是否不再被 Redis 读放大。
- SRH 容器侧 Redis 连接池是否稳定复用。

## 灰度步骤

1. 在 Aiven 同 region 附近部署 SRH 和 HTTPS 入口。
2. 本地或临时脚本用 `@upstash/redis` 连接 SRH，验证 `SET`、`GET`、`MGET`、`SET EX`、pipeline。
3. 在 Worker 代码里加入 `redis-http` 后端，但先不切生产变量。
4. 部署代码，保持 `STATE_STORE_BACKEND=redis`，确认行为不变。
5. 设置 `REDIS_HTTP_URL` 和 `REDIS_HTTP_TOKEN` secret。
6. 将 `STATE_STORE_BACKEND` 切到 `redis-http`。
7. 观察 30-60 分钟日志：
   - `event = "state_store.redis.command"` 是否停止出现。
   - `event = "state_store.redis_http.command"` 是否成功。
   - 上游请求成功率、`prepareDurationMs`、`$workers.outcome` 是否改善。
8. 如果出现异常，直接把 `STATE_STORE_BACKEND` 切回 `redis`。

## 验收标准

- Worker 不再通过 `@redis/client` 直连 Redis TCP。
- 一小时窗口内不再出现 `Error: Disconnects client`。
- `mget failed upstreams` 的 timeout 数显著下降。
- `get instances` 后台刷新失败不再连带打断请求热路径的 `mget failed upstreams`。
- `instances` 和 `fail:*` 的读写语义保持不变。
- 出问题时可以通过环境变量快速回滚到 direct Redis 或 KV。

## 后续风险

- SRH 本身会成为新的单点，需要容器自动重启、HTTPS 证书续期和基础监控。
- proxy 如果离 Aiven 太远，只是把 TCP 跨地域问题变成 HTTP 跨地域问题。
- `@upstash/redis` 与 SRH 目标兼容，但仍需要用本项目实际命令验证返回值、错误和 TTL 行为。
- 如果以后要把这个代理做成通用服务，才需要进一步处理多租户、SSRF 防护、命令白名单、密钥加密、计费和滥用限制。

## 参考

- SRH: https://github.com/hiett/serverless-redis-http
- Upstash TypeScript SDK: https://upstash.com/docs/redis/sdks/ts/overview
- Upstash REST API: https://upstash.com/docs/redis/features/restapi
