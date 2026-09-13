# rsshub-balancer

`rsshub-balancer` 是一个支持 Cloudflare Worker 和 Node 双运行时的 RSSHub 多实例入口。它把多个 RSSHub 实例放在同一个公开域名后面，优先复用实例里已经存在的缓存响应，减少同一路由在多个实例上被重复抓取。

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

项目会自动维护一组可用的 RSSHub 上游实例，并把普通 RSSHub Feed 路由转发到其中一个上游。上游列表来自 RSSHub 官方实例列表，同时保留自维护兜底实例，避免 Redis 或远程列表短暂不可用时入口完全失效。

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
- 请求处理结果（当前记录完整选路的直连上游结果）
- 真实触达的上游分布

这些数据来自 Workers Analytics Engine，主要用于观察这个入口是否真的在复用缓存、减少重复请求，以及流量大致从哪里进入。

首页桑基图已简化为 `country -> outcome -> upstream`，此前 Worker 版本已部署并验证通过；当前共享代理调整尚未重新部署 Worker，Node 回传已完成本地实现，仍待 review 和部署，进度见[实施状态](docs/worker-migration/implementation-status.md)。字段约定见 [Metrics 查询](docs/metrics.md)，后续维度见 [丰富桑基图字段](docs/todo.md#丰富桑基图字段)。

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

`rsshub-balancer` 只面向 RSSHub 场景做轻量 HTTP L7 路由、缓存感知转发、请求合并和简单失败兜底。它不会扩展成完整的软件负载均衡器，也不计划支持通用反向代理、L4 代理、复杂权重调度、通用主动健康检查控制面或长期连接管理。云下迁移先手动切换 Route，后续按需接入自动探活，不引入 DO；服务端本体已完成，部署和切流进度见 [实施状态](docs/worker-migration/implementation-status.md)。

更完整的边界说明见 [docs/capability-boundary.md](docs/capability-boundary.md)。

## 相关文档

- [Metrics 查询](docs/metrics.md)
- [云下迁移方案](docs/worker-migration/README.md)
- [迁移实施状态与本地运行](docs/worker-migration/implementation-status.md)
- [迁移与故障接管操作手册](docs/worker-migration/migration-failover-runbook.md)
- [Redis](docs/redis.md)
- [项目能力边界](docs/capability-boundary.md)
- [云下完整 LB 分流计划](docs/origin-plane-split-plan.md)

## 开发

本仓库使用 `pnpm workspaces` 管理依赖，由 Nx 统一调度开发、构建和本地启动任务。任务定义分别位于 [server/project.json](apps/server/project.json) 和 [web/project.json](apps/web/project.json)。日常开发只需要记住这几个命令：

```txt
pnpm install
pnpm run dev:server
pnpm run dev:node
pnpm run dev:web
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run deploy
```

`dev:web`、`dev:node` 和 `start:node` 使用独立执行器进程并关闭 Nx 的任务环境文件加载，避免根目录环境文件抢先覆盖应用配置；环境文件由 Vite 或 Node 读取。

`apps/server` 的 Worker 入口为 [index.ts](apps/server/src/index.ts)，Node 开发和构建入口均为 [node.ts](apps/server/src/node.ts)，共用 [app.ts](apps/server/src/app.ts) 中的 Hono 路由与 `hono/proxy` 转发。Node 入口读取配置并刷新上游后，通过 `@hono/node-server` 的 `serve({ fetch: app.fetch, ... })` 监听请求，使用库默认的 Request/Response 实现。代理范围与压缩行为见 [HTTP 约定](docs/worker-migration/shared-code-runtime-plan.md#http-与验证)。`apps/web` 是 Vue3 / Vite 首页。首页流量图依赖 Cloudflare Analytics Engine SQL API；本地开发时，相关 Worker secrets 按 Wrangler 默认规则放在 `apps/server/.dev.vars`。

Node 本地开发使用 `apps/server/.env`，从 `.env.example` 复制后填写。`pnpm build:node` 通过 [vite.config.ts](apps/server/vite.config.ts) 将 Node 入口及依赖打包为独立 ESM 产物，`pnpm start:node` 启动；`pnpm build:worker` 构建 Worker 与首页。开发、构建与运行统一使用 Node 26（`>=26.8.2 <27`），容器构建和运行固定使用 26.8.2。

Node 收到终止信号后直接退出，允许中断未完成请求并丢失未上传指标。Docker 运行时使用 `--init`，Compose 设置 `init: true`，由轻量 init 转发信号，避免 Node 直接作为 PID 1 忽略停止信号。日常发布先由 Worker 接管，见[发布与回滚](docs/worker-migration/migration-failover-runbook.md#发布与回滚)。部署配置和未实施项目见 [迁移实施状态](docs/worker-migration/implementation-status.md)。
