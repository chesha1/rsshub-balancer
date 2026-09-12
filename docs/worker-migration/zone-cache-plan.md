# RSS 缓存

Node 使用 Zone Cache，Worker 接管时保留 Workers Cache，前端由 Static Assets 管理。普通 Feed 保留适用的上游缓存头，缺失时沿用平台默认行为。

## Cache Rule

在 `virworks.moe` 的 **Caching → Cache Rules** 新建一条规则，为无扩展名的 RSS 路径赋予缓存资格：

```text
(http.host eq "rsshub-balancer.virworks.moe")
and not (
  http.request.uri.path in {
    "/" "/index.html" "/healthz" "/api" "/_internal" "/_assets"
  }
  or starts_with(http.request.uri.path, "/api/")
  or starts_with(http.request.uri.path, "/_internal/")
  or starts_with(http.request.uri.path, "/_assets/")
)
```

- 缓存资格：`Eligible for cache`。
- 边缘 TTL：`respect_origin`，有缓存头时遵循源站，没有时使用 Cloudflare 默认行为；浏览器 TTL 遵循源站，不添加状态码 TTL。
- 缓存键保留完整 query string，关闭 Query String Sort，保留参数顺序。

资格不保证存储；上述排除也不等于 bypass。上线前核对其他 Cache Rules、Page Rules 和 Cache Response Rules，避免强制缓存保留接口、覆盖 `no-store` 或忽略 query。[Cache Rules 设置](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)

## 两端共享的响应头中间件

将 `workersCacheNoStoreRoutes` 改为共享 `noStoreRoutes`，在业务路由前注册，覆盖 `/healthz`、`/_internal/*`、`/api/*`。在 `await next()` 后对成功和错误响应统一覆盖：

```text
Cache-Control: no-store
Cloudflare-CDN-Cache-Control: no-store
```

Worker 单独挂载的 ingest 也设置双头。中间件只控制执行后的存储，不跳过已有缓存查找或清理旧条目。Cloudflare 专用头可能被平台消费，应用层核对双头，公开入口核对标准头和实际缓存行为。

## 验证与回滚

- 测试规则覆盖普通 RSS，排除精确保留路径及目录子路径，不误伤 `/apix/feed`；带 query 的 `/healthz` 仍排除。
- 同一 Feed 连续请求，结合 `CF-Cache-Status`、`Age` 与 Node/Traefik 日志确认 MISS/HIT；测试不同 query 及顺序、实时接口成功与错误响应的禁止缓存行为。正常 RSS 的 HIT/MISS 均不应进入 Worker。
- 确认后端执行位置须使用确认 MISS 的请求加请求 ID 日志，或受控直连；HIT 不证明接管成功，也不产生应用指标。

Zone Cache 与 Workers Cache 独立，切换不迁移或清空条目。Node 发布不更新 Zone 缓存版本，需要立即替换内容时按受影响 URL 清理；其余沿用 TTL。回滚停用新增规则，已有条目仍须按需清理。[Workers Cache 边界](https://developers.cloudflare.com/workers/cache/)
