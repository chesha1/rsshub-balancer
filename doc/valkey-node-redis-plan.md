# 使用 @redis/client 接入 Aiven Valkey 的实施计划

## 背景

当前仓库运行在 Cloudflare Workers 上，状态数据原本通过 `KV` binding 访问。需要统一迁移的状态只有两类：

- `instances`：上游实例列表，由首页、健康检查、路由状态查询和定时任务读取，定时任务负责刷新写入。
- `fail:*`：某个上游在某条路由上的短 TTL 失败标记，请求转发失败时通过 `waitUntil` 后台写入。

迁移原则是：**同一套状态 key 必须整体写入同一个后端**。不能把 `instances` 留在 Cloudflare KV、把 `fail:*` 放到 Redis，也不能让不同 key 分散到不同外部 KV 存储里。

## 后端选择

使用 `STATE_STORE_BACKEND` 统一决定整套状态写入哪里：

```jsonc
{
  "vars": {
    "STATE_STORE_BACKEND": "redis"
  }
}
```

可选值：

- `kv`：`instances` 和 `fail:*` 全部写入 Cloudflare KV。
- `redis`：`instances` 和 `fail:*` 全部写入外部 Redis / Aiven Valkey。

这样回滚时只需要把 `STATE_STORE_BACKEND` 改回 `kv`，不会出现不同 key 跨后端混用的问题。

## 技术选择

计划使用 `@redis/client`，也就是 node-redis 的基础客户端包，而不是完整的 `redis` umbrella 包。

选择理由：

- 生态和维护信号强于小众 Workers 专用 Redis 客户端。
- API 现代，支持 `async/await`。
- 支持 `redis://` / `rediss://` URL；生产优先使用 `rediss://`，不额外传入自定义 CA / client certificate / key。
- 支持 `disableOfflineQueue`、`commandsQueueMaxLength`、`socket.connectTimeout`、`socket.reconnectStrategy` 等选项，适合在边缘请求路径上控制失败行为。

主要风险：

- Cloudflare Workers 的 `nodejs_compat` 不是完整 Node.js，只提供一部分 Node API。
- `node:net` 在 Workers 中映射到底层 `cloudflare:sockets`，但 `node:tls` 是部分支持，需要实际验证 Aiven Valkey 的 TLS 连接。
- node-redis 并非专门面向 Workers 运行时设计，必须先灰度验证，不应直接移除 KV 回滚路径。

## 配置

依赖：

```txt
pnpm add @redis/client
```

`wrangler.jsonc`：

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "STATE_STORE_BACKEND": "redis"
  }
}
```

Redis 后端需要新增 Worker secret：

```txt
pnpm wrangler secret put VALKEY_URL
```

`VALKEY_URL` 使用 Aiven 控制台提供的服务 URI，优先使用 `rediss://`。本地开发放到 `.dev.vars`，不要提交到仓库。

## 存储抽象

新增 `src/store.ts`，定义业务需要的最小接口：

```ts
export type StateStore = {
  getInstances(): Promise<string[] | undefined>
  setInstances(upstreams: string[]): Promise<void>
  getFailedUpstreams(upstreams: readonly string[], pathname: string): Promise<Set<string>>
  markUpstreamFailed(upstream: string, pathname: string, ttlSeconds: number): Promise<void>
}
```

实现两个 store：

- `KvStateStore`：`instances` 和 `fail:*` 全部写入 Cloudflare KV。
- `RedisStateStore`：`instances` 和 `fail:*` 全部写入外部 Redis / Aiven Valkey。

`createStateStore(env)` 根据 `STATE_STORE_BACKEND` 返回其中一个实现。业务代码只依赖 `StateStore`，不直接关心底层资源。

## Key 设计

两种后端沿用当前业务 key 格式，不额外增加前缀、不 hash、不做 key 结构迁移：

```txt
instances
fail:${upstream}|${pathname}
```

这样可以：

- 避免把后端迁移和 key 迁移混在一起。
- 让 Redis 后端与当前 Cloudflare KV 后端保持一致的读写语义。
- 确保选择 `kv` 或 `redis` 时，整套 key 都在同一个资源里。

## Redis 行为

`instances` 使用普通 string：

```txt
GET instances
SET instances <json>
```

失败标记使用短 TTL string：

```txt
MGET fail:${upstream1}|${pathname} fail:${upstream2}|${pathname} ...
SET fail:${upstream}|${pathname} 1 EX <failTtl>
```

写入失败标记仍放在 `waitUntil` 中，避免阻塞当前响应。

## 降级与回滚

请求路径的降级原则：

- 读取 `instances` 失败：使用 `config.fallbackUpstreams` 临时兜底。
- 读取失败标记失败：视为没有失败标记，继续探测所有 upstream。
- 写入失败标记失败：记录 warning，忽略本次失败标记写入。

回滚方式：

1. 将 `STATE_STORE_BACKEND` 改成 `kv`。
2. 重新部署 Worker。
3. Redis 中的 `fail:*` 自然过期即可。
4. `instances` 在 KV 后端首次为空时会用 `fallbackUpstreams` 播种，下一次 cron 会刷新成健康实例列表。

## 验证与观测

本地验证：

```txt
pnpm run lint
pnpm run dev
```

手动验证：

- `/healthz`
- `/api/route/status?requestPath=/some/rss/path`
- 普通 RSS 路由 GET
- 非 GET 请求转发

线上重点观察：

- Cloudflare KV write 次数是否下降。
- `upstream.cache_probe` 的命中率是否异常变化。
- `upstream.fetch` 的 `prepareDurationMs` 是否显著增加。
- Redis 连接失败日志数量。
- Aiven 侧连接数、内存、CPU、网络流量。

## 参考资料

- Cloudflare Workers Node.js compatibility: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Cloudflare Workers `node:net`: https://developers.cloudflare.com/workers/runtime-apis/nodejs/net/
- Cloudflare Workers `node:tls`: https://developers.cloudflare.com/workers/runtime-apis/nodejs/tls/
- Cloudflare Workers secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- node-redis repository: https://github.com/redis/node-redis
- node-redis client configuration: https://github.com/redis/node-redis/blob/master/docs/client-configuration.md
- Redis Node.js TLS guide: https://redis.io/docs/latest/develop/clients/nodejs/connect/
- Aiven Valkey NodeJS guide: https://aiven.io/docs/products/valkey/howto/connect-node
