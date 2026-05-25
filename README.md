# rsshub-balancer

`rsshub-balancer` 是一个部署在 Cloudflare Workers 上的 RSSHub 多实例入口。它把多个 RSSHub 实例放在同一个公开域名后面，优先复用实例里已经存在的缓存响应，减少同一路由在多个实例上被重复抓取。

当前线上地址：

- <https://rsshub-balancer.virworks.moe>

把它当作普通 RSSHub 实例使用即可。比如原始 RSSHub 路由是：

```txt
/github/repos/DIYgod/RSSHub/releases
```

那么对应的订阅地址就是：

```txt
https://rsshub-balancer.virworks.moe/github/repos/DIYgod/RSSHub/releases
```

如果已经在使用其他 RSSHub 实例，只需要把订阅链接里的域名替换为 `rsshub-balancer.virworks.moe`，后面的路径和查询参数保持不变。

## 主要功能

### RSSHub 多实例入口

项目会自动维护一组可用的 RSSHub 上游实例，并把普通 RSSHub Feed 路由转发到其中一个上游。上游列表来自 RSSHub 官方实例列表，同时保留自维护兜底实例，避免状态存储或远程列表短暂不可用时入口完全失效。

### 缓存感知路由

在真正请求上游之前，项目会先查询各个 RSSHub 实例的 `/api/route/status`，判断哪个实例已经缓存了当前路由。命中缓存时，会优先把请求转发给已有缓存的实例，让它直接返回缓存内容，而不是让另一个实例重新抓取原始网站。

这也是本项目最核心的目标：不是做通用负载均衡，而是围绕 RSSHub 已有缓存做一层轻量选择。

### 并发请求合并

对于同一路径、同一方法的并发 `GET` / `HEAD` 请求，Worker 会尽量让它们复用同一次上游请求结果。这样在阅读器集中刷新、热门订阅短时间内被多人访问时，可以减少对上游 RSSHub 实例的重复请求。

当前实现以 Worker isolate 内合并为主，并保留少量 Durable Object 路径用于跨 isolate 合并观察。

### 简单失败兜底

如果某个上游在处理当前路由时失败，项目会记录一个短 TTL 的失败标记。后续同一路由会优先尝试其他未标记失败的上游；如果没有缓存命中，也会按顺序兜底重试，直到拿到可用响应或返回失败。

这不是完整的健康检查或熔断系统，但足够覆盖 RSSHub 入口的常见轻量故障场景。

### 首页状态与流量观测

线上首页会展示：

- 当前使用中的 RSSHub 上游实例
- 最近 24 小时请求来源国家/地区
- Cloudflare 入口机房分布
- 请求处理结果，包括直连上游、isolate 合并和 DO 合并
- 真实触达的上游分布

这些数据来自 Workers Analytics Engine，主要用于观察这个入口是否真的在复用缓存、减少重复请求，以及流量大致从哪里进入。

### RSSHub 接口兼容范围

当前入口重点支持普通 Feed 路由：

| 路径 | 行为 |
| --- | --- |
| `/:namespace/:path` | 负载均衡到 RSSHub 上游 |
| `/` | 自定义首页 |
| `/healthz` | 聚合检查上游健康状态 |
| `/robots.txt` | 禁止搜索引擎索引 |
| `/api/route/status` | 聚合查询任一上游是否已缓存指定路由 |
| `/metrics` | 不对外开放，指标写入 Workers Analytics Engine |
| `/api/openapi.json`、`/api/reference` 等元数据接口 | 不对外提供，请直接访问上游 RSSHub 实例 |

## 项目边界

`rsshub-balancer` 只面向 RSSHub 场景做轻量 HTTP L7 路由、缓存感知转发、请求合并和简单失败兜底。它不会扩展成完整的软件负载均衡器，也不计划支持通用反向代理、L4 代理、复杂权重调度、主动健康检查控制面或长期连接管理。

更完整的边界说明见 [docs/capability-boundary.md](docs/capability-boundary.md)。

## 相关文档

- [Metrics 查询](docs/metrics.md)
- [状态存储后端](docs/state-store-backends.md)
- [项目能力边界](docs/capability-boundary.md)

## 开发

本仓库使用 `pnpm workspaces + Nx`。日常开发只需要记住这几个命令：

```txt
pnpm install
pnpm run dev:server
pnpm run dev:web
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run deploy
```

`apps/server` 是 Cloudflare Worker / Hono 后端，`apps/web` 是 Vue3 / Vite 首页。首页流量图依赖 Cloudflare Analytics Engine SQL API；本地开发时，相关 Worker secrets 按 Wrangler 默认规则放在 `apps/server/.dev.vars`。
