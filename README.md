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

首页展示：

- 当前使用中的 RSSHub 上游实例
- 最近 24 小时请求来源国家/地区
- 真实触达的上游分布
- 国家到上游的请求数量

流量数据来自 Workers Analytics Engine，只记录来源国家/地区和最终上游，用于观察请求从哪里进入、由哪些实例承接。

首页桑基图当前展示 `country -> upstream`，保留维度复选框和按可见列绘图的逻辑，请求数使用平台采样权重求和。双字段格式和配套首页已部署，写入与查询使用新数据集 `rsshub_balancer_request_flows`，与旧格式数据隔离。Node 已部署，主域名于 2026-09-22 完成首次切流；2026-09-23 公开指标查询已返回最近 24 小时的数据，用户也已通过各类 Dashboard 确认线上运行良好、验收完成，记录见[实施状态](docs/worker-migration/implementation-status.md)。字段约定见 [Metrics 查询](docs/metrics.md)，后续维度见 [丰富桑基图字段](docs/todo.md#丰富桑基图字段)。

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

`rsshub-balancer` 只面向 RSSHub 场景做轻量 HTTP L7 路由、缓存感知转发、请求合并和简单失败兜底。它不会扩展成完整的软件负载均衡器，也不计划支持通用反向代理、L4 代理、复杂权重调度、通用主动健康检查控制面或长期连接管理。云下迁移及线上验收已完成；下一步接入独立探活 Worker 自动接管，并通过 GitHub Actions flow 提供手动接管／恢复，恢复保持手动，不引入 DO。进度见[实施状态](docs/worker-migration/implementation-status.md)。

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

本仓库使用 pnpm 12 的 workspaces 管理依赖，本地与 Docker 构建均按大版本约束。任务由 Nx 统一调度，Worker、Node 分别装配平台能力，共享包提供同一份业务逻辑：

```text
apps/
  worker/             # Worker 入口、Redis 短连接、指标写入与 ingest、Vite/Wrangler 配置
  node/               # Node 入口、Redis 连接复用、指标上传、Vite 配置和 Dockerfile
  web/                # Vue 首页，由 Worker 托管
packages/
  server-core/        # Hono 路由、上游选择与刷新、存储规则、指标协议、公共日志
```

两个应用通过 `workspace:*` 依赖 `server-core`，共享包不导入任何应用。应用启动时通过 `redis.configureRedis()` 和 `metrics.configureMetrics()` 固定平台实现，业务直接调用模块函数；上游缓存由模块保存，供当前进程或 isolate 的 HTTP 与定时刷新共用。两端各自创建 Hono 应用，依次注册公共中间件、平台专属路由和共享路由，ingest 只存在于 Worker。共享包直接导出 TypeScript 源码，由两端各自打包，不需要独立发布。

任务定义位于 [worker/project.json](apps/worker/project.json)、[node/project.json](apps/node/project.json)、[server-core/project.json](packages/server-core/project.json) 和 [web/project.json](apps/web/project.json)。Worker 构建依赖首页构建，Node 构建只包含后端；Nx 的构建和类型检查缓存包含共享包源码。日常命令：

```txt
pnpm install
pnpm run dev:worker
pnpm run dev:node
pnpm run dev:web
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run deploy
```

开发命令和 `start:node` 使用独立执行器进程并关闭 Nx 的任务环境文件加载，避免根目录环境文件抢先覆盖应用配置；环境文件由应用自己的 Vite/Cloudflare 插件或 Node 读取。

Worker 入口为 [worker/src/index.ts](apps/worker/src/index.ts)，Node 开发和构建入口均为 [node/src/index.ts](apps/node/src/index.ts)，共用 [server-core/src/app.ts](packages/server-core/src/app.ts) 中的 Hono 路由与 `hono/proxy` 转发。两端各自的 `src/app.ts` 配置存储和指标实现，并挂载共享路由。Node 入口读取配置并刷新上游后，通过 `@hono/node-server` 的 `serve({ fetch: app.fetch, ... })` 监听请求，使用库默认的 Request/Response 实现。代理范围与压缩行为见 [HTTP 约定](docs/worker-migration/shared-code-runtime-plan.md#http-与验证)。Worker secrets 按 Wrangler 默认规则放在 `apps/worker/.dev.vars`；`dev:server` 保留为 `dev:worker` 的兼容命令。

Node 本地开发使用 `apps/node/.env`，从 [apps/node/.env.example](apps/node/.env.example) 复制后填写。`pnpm build:node` 通过 [vite.config.ts](apps/node/vite.config.ts) 将 Node 入口及依赖打包为独立 ESM 产物 `dist/apps/node/node.js`，`pnpm start:node` 启动。开发、构建与运行统一使用 Node 26（`26.x`），容器构建和运行使用 `node:26-bookworm-slim`。

`pnpm dev:worker` 使用 Vite 和官方 Cloudflare 插件开发，监听 `http://127.0.0.1:8787`；`dev:server` 使用同一任务。配合 `pnpm dev:web` 开发首页时，前端代理连接该地址。Worker 开发先准备首页构建产物，直接访问 `8787` 也能查看构建后的首页。 Worker 源码变化时整体重载业务模块，使一次性配置和模块缓存随代码一起重新初始化。

插件默认启用 Remote bindings 支持，支持远程连接的具体资源在 `wrangler.jsonc` 中配置 `remote: true`；Worker 代码仍在本机 workerd 执行。当前 `METRICS` 的 Analytics Engine 不支持远程绑定，使用本地模拟；Redis 由 SDK 直连 `apps/worker/.dev.vars` 中的 `VALKEY_URL`。资源支持范围见 [Cloudflare 开发模式支持表](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)。

`pnpm build:worker` 先构建首页，再通过 [Worker Vite 配置](apps/worker/vite.config.ts) 和官方 Cloudflare 插件生成 `dist/apps/worker/server/index.js`、独立 Redis SDK 模块及 `public/` 静态资源。Worker 开启 `new_module_registry`，首次访问 Redis 时才导入 SDK，ingest 不加载它；模块缓存不会复用 Redis 连接。`pnpm deploy` 先构建，再使用生成的 `server/wrangler.json` 发布，保留 `no_bundle` 和模块规则，避免再次合包；Worker 与首页仍一起发布。

Node 收到终止信号后直接退出，允许中断未完成请求并丢失未上传指标。Docker 运行时使用 `--init`，Compose 设置 `init: true`，由轻量 init 转发信号，避免 Node 直接作为 PID 1 忽略停止信号。日常发布先由 Worker 接管，见[发布与回滚](docs/worker-migration/migration-failover-runbook.md#发布与回滚)。部署配置和未实施项目见 [迁移实施状态](docs/worker-migration/implementation-status.md)。

### Node 镜像 CI

[Node image 工作流](.github/workflows/node-image.yml) 仅在向 `main` 推送 Node 相关变更时触发：Node 应用、共享后端、workspace 依赖清单、锁文件及构建/检查配置。仅修改 Worker 或 Web 源码、迁移文档不会触发；修改它们的 `package.json` 或公共锁文件会触发，因为 Docker 安装依赖会读取这些文件。

CI 先执行 Node 与共享后端的类型检查和 lint，通过后使用现有 Dockerfile 构建 `linux/amd64`、`linux/arm64` 镜像并推送到 `ghcr.io/chesha1/rsshub-balancer`，生成 `sha-<完整提交 SHA>` 和 `latest` 标签。PR 不触发工作流，也不提供手动触发入口。

发布使用 GitHub 自动提供的 `GITHUB_TOKEN` 和工作流声明的 `packages: write`，无需另配仓库推送密码。首次发布后检查 GHCR 包的可见性：公开包可匿名拉取，私有包需要服务器使用有 `read:packages` 权限的凭据登录。具体依据见 [GitHub 容器仓库文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

成功发布的 Actions 摘要会列出版本标签及 `ghcr.io/chesha1/rsshub-balancer@sha256:...`。部署优先记录并使用 digest；同一提交重跑可能因 Node/pnpm 大版本内更新产生不同镜像，SHA 标签仍可能被覆盖。CI 不清理历史镜像，保留正在使用和回滚所需的 digest。服务器更新按[发布与回滚](docs/worker-migration/migration-failover-runbook.md#发布与回滚)手动执行。
