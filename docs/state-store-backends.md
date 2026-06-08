# 状态存储后端现状

本文档替代之前分散的 Redis 排查计划、日志样本和迁移草案，只保留当前结论和后续选择依据。

## Where it stands

当前已经验证过三种状态存储后端：

- `redis`：Worker 通过 `@redis/client` 直连外部 Redis / Aiven Valkey。
- `redis-http`：Worker 通过 `@upstash/redis` 访问自部署 Redis HTTP proxy，再由 proxy 连接 Redis / Valkey。
- `kv`：使用 Cloudflare 原生 KV。

这三种后端现在都可以跑通。当前默认配置是 `STATE_STORE_BACKEND=redis`，也就是 Redis 直连。

目前最优选择仍然是 `redis`。之前主要担心 Worker 并发请求会同时打开太多 Redis 连接，从而把 Redis 打爆；经过单命令短连接方案测试后，这个担心暂时没有兑现。直连 Redis 不需要额外维护 proxy，路径也最短，因此应该继续作为当前主路径。

`redis-http` 适合作为未来高流量阶段的备用方向。如果将来直连 Redis 的连接数真的非常高，用户量也显著上升，再把 Redis TCP 连接池收敛到一个自部署 HTTP proxy 上会更合理。这个方案需要额外维护 proxy 服务、token、网络位置和容器健康状态，所以现在不应该优先引入为主路径。

`kv` 可以作为回滚或低频状态存储使用，但不适合作为当前写入模式的主路径。项目当前会写入 `instances` 和 `fail:*` 失败标记，其中 `fail:*` 与路由、上游失败和 TTL 相关，写入频率可能明显高于 Cloudflare KV 更舒服的使用区间。如果要继续使用 Cloudflare 原生 KV，需要先降低写入频率，或者调大失败标记 TTL，让同一段时间内重复标记同一路由和上游的机会减少。

## 后端选择

| 后端 | 当前状态 | 适用场景 | 主要代价 |
| --- | --- | --- | --- |
| `redis` | 当前推荐 | 当前生产主路径；写入频率较高但仍想保持简单架构 | 每条命令都要从 Worker 建立到外部 Redis 的连接 |
| `redis-http` | 已实现，可切换 | 将来连接数极高，需要把连接池集中到自部署服务 | 需要额外部署、监控和保护 HTTP proxy |
| `kv` | 可用，不推荐做当前主路径 | 回滚、低频配置、写入不密集的辅助状态 | 高频写入不合适，成本、限制和最终一致性都不理想 |

## 当前实现结论

- `STATE_STORE_BACKEND=redis` 需要配置 `VALKEY_URL`。
- `STATE_STORE_BACKEND=redis-http` 需要配置 `REDIS_HTTP_URL` 和 `REDIS_HTTP_TOKEN`，也兼容 `UPSTASH_REDIS_REST_URL` 与 `UPSTASH_REDIS_REST_TOKEN`。
- `STATE_STORE_BACKEND=kv` 使用 Worker 绑定里的 `KV` namespace。
- 三种后端共享同一组业务语义：`instances` 保存上游实例列表，`fail:<encoded-pathname>:<encoded-upstream>` 保存某个上游对某个路径的临时失败标记。
- 直连 Redis 已改成单命令短连接：每次状态存储操作执行 `connect -> command -> destroy`，不再跨请求或跨命令复用同一个 Redis client。
- `instances` 已经有运行时内存缓存和后台刷新，避免每个请求都强依赖一次状态存储读取。

## 最近 release 相关提交

- `b230a18 feat: 将状态存储从 Cloudflare KV 迁移到外部 Redis`：引入统一的 `StateStore` 抽象，把 `instances` 和 `fail:*` 从 KV 路径迁移到 Redis / Valkey 路径。
- `7b068de chore: 补充实例列表 stale cache 方案` 与 `d74cb46 feat: 添加实例列表内存缓存刷新`：确认 `instances` 是低频配置，并用本地 stale cache 降低请求热路径对状态存储读取的依赖。
- `3e16d74 feat: 添加 Redis 超时诊断日志`：补充 Redis connect、command、client lifecycle 相关诊断字段，用来定位超时和断连来源。
- `c2c0c05 fix: 通过抽样降低 Durable Object 压力`：降低 Durable Object 参与比例，验证 Redis 压力不只来自 DO 层。
- `662bfec chore: 补充 Redis HTTP 代理迁移分析` 与 `9340a83 feat: 接入 Redis HTTP proxy 状态存储`：实现 `redis-http` 后端，让 Worker 可以通过自部署 HTTP proxy 访问 Redis。
- `810d2f2 fix: 为 Redis 直连改用单命令短连接`：将直连 Redis 从共享 client 调整为单命令短连接，并把当前默认后端切回 `redis`。

## 后续判断规则

短期继续使用 `redis`，重点观察 Redis 服务端连接数、命令延迟、拒绝连接数，以及 Worker 日志里的 `state_store.redis.command` 失败率。

只有在直连 Redis 的连接数或连接失败率真的成为主要问题时，才切到 `redis-http`。切换前需要确保自部署 proxy 与 Redis / Valkey 足够接近，且 proxy 的连接池、健康检查、token 和日志已经准备好。

只有在写入频率被明显压低，或者失败标记 TTL 调整后写放大可接受时，才重新考虑 Cloudflare 原生 KV 作为主路径。
