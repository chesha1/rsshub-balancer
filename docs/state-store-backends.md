# 状态存储现状与迁移设计

[云下迁移方案](./worker-migration/shared-code-runtime-plan.md#状态存储)已确定只保留直连 Redis / Valkey；以下区分当前代码和待实施设计。

## 当前代码

[store.ts](../apps/server/src/store.ts) 仍包含三种后端，由 `STATE_STORE_BACKEND` 选择；[Wrangler 配置](../apps/server/wrangler.jsonc) 当前选择 `redis`。

| 后端 | 实现 | 当前配置 |
| --- | --- | --- |
| `redis` | `@redis/client` 直连 Redis / Valkey | `VALKEY_URL` |
| `redis-http` | `@upstash/redis` 通过 Redis HTTP proxy 访问 | `REDIS_HTTP_URL`、`REDIS_HTTP_TOKEN`，兼容 `UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN` |
| `kv` | Cloudflare KV | `KV` binding；后端配置缺失或未知时回退到此实现 |

直连 Redis 当前每条命令执行 `connect -> command -> destroy`。实例列表已有内存缓存，过期时后台读取状态存储；失败标记也在后台写入。Redis 日志包含连接、命令及 client 生命周期诊断字段。

## 确定的迁移设计

两端使用同一份 `RedisStateStore`，保留 `StateStore` 的四个业务操作，共享 GET/SET/MGET、key 编码、JSON 和 TTL 逻辑。运行时入口固定注入连接执行函数及状态前缀：

| 入口 | Redis 连接生命周期 | 状态前缀 |
| --- | --- | --- |
| Worker | 当前请求或事件内按需执行每命令短连接，命令结束时关闭 | `worker:` |
| Node | 进程内保存并复用同一个 SDK client，退出时关闭 | `node:` |

两端分别维护各自的实例列表和失败标记。连接策略由入口确定，部署配置只需提供 Redis 地址及凭据。连接超时、命令超时、并发和退出要求见 [Redis 连接生命周期](./worker-migration/shared-code-runtime-plan.md#redis-连接生命周期)，共享代码结构见 [共享代码与运行时方案](./worker-migration/shared-code-runtime-plan.md)。

列表过期刷新和失败标记写入统一改为请求内 `await`，缓存、fallback 及写入异常处理按 [请求内状态操作](./worker-migration/shared-code-runtime-plan.md#请求内状态操作)执行。

实施时删除：

- KV 实现、Worker KV binding 及相关类型。
- `redis-http` 实现、`@upstash/redis` 依赖，以及上述 HTTP 配置变量和兼容别名。
- `STATE_STORE_BACKEND`、后端选择函数、工厂分支及未知配置回退逻辑。

验证时观察 Redis 连接数、命令延迟、拒绝连接数及命令失败日志，核对两端各自的连接生命周期与状态隔离。
