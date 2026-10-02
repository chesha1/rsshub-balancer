# rsshub-balancer

`rsshub-balancer` 是一个 RSSHub 多实例入口，把多个 RSSHub 实例放在同一个公开域名后面，优先复用实例里已经存在的缓存响应，减少同一路由在多个实例上被重复抓取。

日常 RSS 请求由 Node 源站（Origin）处理；Cloudflare 边缘应用（Edge）托管首页、静态资源并接收源站指标，在源站故障时接管 RSS 请求。独立 Watchdog 定时探活，控制接管与恢复。Origin 和 Edge 共享同一套选路与转发逻辑。

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

项目会自动维护一组可用的 RSSHub 上游实例，并把普通 RSSHub Feed 路由转发到其中一个上游。Origin 和 Edge 分别每小时拉取 RSSHub 官方实例列表，加入自维护实例，再通过 `/healthz` 筛选可用实例。刷新失败时保留旧列表。

### 缓存感知路由

在真正请求上游之前，项目会先查询各个 RSSHub 实例的 `/api/route/status`，判断哪个实例已经缓存了当前路由。命中缓存时，会优先把请求转发给已有缓存的实例，让它直接返回缓存内容，而不是让另一个实例重新抓取原始网站。

探测并发进行，每个实例最多等待 1 秒；全部探测完成或超时后，从时限内返回命中的实例中等概率随机选择首个请求目标。若没有命中，则随机尝试可用实例。探测超时仅表示未确认缓存，不会排除该实例参与后续请求。

这也是本项目最核心的目标：不是做通用负载均衡，而是围绕 RSSHub 已有缓存做一层轻量选择。

### 简单失败兜底

如果某个上游在处理当前路径时失败，项目会写入有效期为 6 小时的失败标记，并继续尝试其他候选。标记按请求路径和上游区分，不含查询参数；有效期内，同路径请求会跳过该上游。所有候选均被标记或本次尝试全部失败时返回 502。

Origin 和 Edge 分别维护实例列表与失败标记。这里的失败避让作用于 RSSHub 上游，与 Watchdog 在 Origin 和 Edge 之间切换入口是两件事。

### 首页状态与流量观测

首页展示：

- 当前承接 RSS 请求的 Origin 或 Edge 所使用的候选上游实例
- 最近 24 小时请求来源国家/地区
- 成功上游与请求失败的分布
- 国家、一级路径到处理结果的请求数量

流量数据来自 Workers Analytics Engine，只记录来源国家/地区、请求一级路径和请求最终结果。Edge 直接写入，Origin 批量上传至 Edge 后写入同一数据集。国家与一级路径在请求进入代理时采集，选路完成后记录成功上游 URL，或统一的“请求失败”，每个被记录的请求只写入一条记录。所有上游尝试失败和命中失败标记统一归类，不计入某个上游的成功请求。

统计只覆盖实际进入 RSS 代理的 `GET` / `HEAD` 请求，不包含首页、本站资源、健康检查、内部接口和 Cloudflare 缓存直接返回的请求。一级路径也包含无法识别的请求，不代表有效订阅数量。指标允许丢失，展示的是近似请求数量，不是入口总访问量。

首页桑基图展示 `country -> path -> upstream`，最后一列为成功上游或“请求失败”。国家/地区与一级路径各展示请求量前 30 项，其余合并为“其他”，请求总量不变。`path` 只保留原始请求 `pathname` 的第一级，例如 `/github/repos/DIYgod/RSSHub/releases` 记录为 `/github`，不记录后续路径段或查询字符串。请求数使用平台采样权重求和；写入与查询使用数据集 `rsshub_balancer_request_results`。字段约定和新数据集发布顺序见 [Metrics 查询](docs/metrics.md)。

### RSSHub 接口兼容范围

当前入口重点支持普通 Feed 路由：

| 路径 | 行为 |
| --- | --- |
| `/:namespace/:path` | `GET` / `HEAD` 按缓存探测和失败避让结果转发到 RSSHub 上游，其他方法返回 405 |
| `/` | 自定义首页 |
| `/_assets/*`、根目录静态文件（如 `/favicon.ico`、`/apple-touch-icon.png`） | 本站资源：`/_assets/*` 下的首页构建产物由 Edge 返回，其余地址在本地返回 404；均不转发到 RSSHub 上游，也不计入统计 |
| `/healthz` | 任一候选上游的健康接口返回 2xx 且正文为 `ok` 时返回 200，否则返回 503 |
| `/robots.txt` | 禁止搜索引擎索引 |
| `/api/route/status` | 聚合查询任一上游是否已缓存指定路由 |
| `/metrics` | 不对外开放，指标写入 Workers Analytics Engine |
| `/api/openapi.json`、`/api/reference` 等元数据接口 | 不对外提供，请直接访问上游 RSSHub 实例 |

根目录静态文件指根目录下只有一个路径段、扩展名为图片、图标、样式、脚本或字体的地址（`ico`、`png`、`jpg`、`jpeg`、`gif`、`webp`、`avif`、`svg`、`css`、`js`、`mjs`、`woff`、`woff2`、`ttf`、`otf`、`eot`，不区分大小写），与 `/_assets` 目录一起归本站所有。归属只看请求路径，不看查询字符串和请求头；带后续路径段的地址（如 `/example/user.png`）和其他扩展名（如 `/feed.xml`）仍按普通 Feed 路由代理。

长期 Worker Routes 不包含根目录文件：即使把 `/favicon.ico` 等文件加入首页构建产物，也只有 `pnpm dev:edge` 和故障接管期间能访问，日常运行时仍由 Origin 返回 404。需要提供这类文件时，须同时增加对应的 Worker Route，见[运行与接管](#运行与接管)。

## 项目边界

`rsshub-balancer` 只面向 RSSHub 场景做轻量 HTTP L7 路由、缓存感知转发、失败避让和源站故障接管。它不会扩展成完整的软件负载均衡器，也不计划支持通用反向代理、L4 代理、复杂权重调度、通用主动健康检查控制面或长期连接管理。

更完整的边界说明见 [docs/capability-boundary.md](docs/capability-boundary.md)。

## 相关文档

- [Metrics 查询](docs/metrics.md)
- [Redis](docs/redis.md)
- [项目能力边界](docs/capability-boundary.md)
- [Node 源站发布策略](docs/origin-release-strategy.md)
- [Cloudflare 规则](docs/cloudflare.md)

## 运行与接管

主域名 `rsshub-balancer.virworks.moe` 的 RSS 和业务查询经 Cloudflare 橙云、Traefik 到 Node；Worker 固定承接首页、静态资源和精确的 `POST /_internal/metrics/ingest`。长期 Worker Routes 为 `/`、`/_assets/*`、`/_internal/metrics/ingest`，均绑定 `rsshub-balancer`。故障接管时增加 `rsshub-balancer.virworks.moe/* -> rsshub-balancer`，恢复时只删除这条 catch-all；固定 Node 验证入口是 `rsshub-balancer-origin.virworks.moe`。Routes 在 Cloudflare zone 管理，不由 Wrangler 部署配置管理。

独立 [watchdog](apps/watchdog/) 启用后每 3 分钟执行一轮检查：正常时探测主域名，接管时探测固定 Node 入口。健康检查要求 `/healthz` 的状态码与应用标识正确，且配置的业务 Feed 均通过状态码、XML 格式和条目内容检查。同一轮内连续两次失败时接管，连续两次健康时恢复，两次探测间隔 10 秒；每轮最多修改一次 Route，并读回结果。删除 watchdog 不会移除已经创建的接管 Route；首次部署或删除后重建时，Routes API token 需从 `apps/watchdog/.dev.vars` 使用 Wrangler `--secrets-file` 注入。

日常更新 Node 镜像直接重建云下单实例，接受短暂断流，不主动切到 Worker。原因和回滚约定见 [Node 源站发布策略](docs/origin-release-strategy.md)。

## 开发

本仓库使用 pnpm 12 的 workspaces 管理依赖，本地与 Docker 构建均按大版本约束。任务由 Nx 统一调度，应用按职责命名：`origin` 是 Node 源站，`edge` 是边缘业务应用，`watchdog` 负责探活与自动接管／恢复，`web` 是浏览器端页面。

```text
apps/
  edge/               # Cloudflare 边缘业务、Redis 短连接、指标写入与 ingest
  origin/             # Node 源站、Redis 连接复用、指标上传和 Dockerfile
  watchdog/           # 独立 Cron Worker，检查源站并控制自动接管与恢复
  web/                # Vue 首页，由 edge 托管
packages/
  server-core/        # Hono 路由、上游选择与刷新、存储规则、指标协议、公共日志
```

`edge` 和 `origin` 通过 `workspace:*` 依赖 `server-core`，共享包不导入任何应用。应用启动时通过 `redis.configureRedis()` 和 `metrics.configureMetrics()` 固定平台实现，业务直接调用模块函数；上游缓存由模块保存，供当前进程或 isolate 的 HTTP 与定时刷新共用。两端各自创建 Hono 应用，依次注册公共中间件、平台专属路由和共享路由，ingest 只存在于 Worker。共享包直接导出 TypeScript 源码，由两端各自打包，不需要独立发布。

任务定义位于 [edge/project.json](apps/edge/project.json)、[origin/project.json](apps/origin/project.json)、[watchdog/project.json](apps/watchdog/project.json)、[web/project.json](apps/web/project.json) 和 [server-core/project.json](packages/server-core/project.json)。Worker 构建依赖首页构建，Node 构建只包含后端；Nx 的构建和类型检查缓存包含共享包源码。日常命令：

```txt
pnpm install
pnpm run dev:edge
pnpm run dev:origin
pnpm run dev:web
pnpm run dev:watchdog
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run deploy:edge
```

开发命令和 `start:origin` 使用独立执行器进程并关闭 Nx 的任务环境文件加载，避免根目录环境文件抢先覆盖应用配置；环境文件由应用自己的 Vite/Cloudflare 插件或 Node 读取。

Worker 入口为 [edge/src/index.ts](apps/edge/src/index.ts)，Node 开发和构建入口均为 [origin/src/index.ts](apps/origin/src/index.ts)，共用 [server-core/src/app.ts](packages/server-core/src/app.ts) 中的 Hono 路由与 `hono/proxy` 转发。两端各自的 `src/app.ts` 配置存储和指标实现，并挂载共享路由。Node 入口读取配置并刷新上游后，通过 `@hono/node-server` 的 `serve({ fetch: app.fetch, ... })` 监听请求，使用库默认的 Request/Response 实现。Worker secrets 按 Wrangler 默认规则放在 `apps/edge/.dev.vars`。

Node 本地开发使用 `apps/origin/.env`，从 [apps/origin/.env.example](apps/origin/.env.example) 复制后填写。`pnpm build:origin` 通过 [vite.config.ts](apps/origin/vite.config.ts) 将 Node 入口及依赖打包为独立 ESM 产物 `dist/apps/origin/index.js`，`pnpm start:origin` 启动。开发、构建与运行统一使用 Node 26（`26.x`），容器构建和运行使用 `node:26-bookworm-slim`。

`pnpm dev:edge` 使用 Vite 和官方 Cloudflare 插件开发，监听 `http://127.0.0.1:8787`。配合 `pnpm dev:web` 开发首页时，`/api`、`/healthz` 和 `/robots.txt` 的前端代理连接该地址。Worker 开发先准备首页构建产物，直接访问 `8787` 也能查看构建后的首页。 Worker 源码变化时整体重载业务模块，使一次性配置和模块缓存随代码一起重新初始化。

`pnpm dev:web` 将所有 `/_internal` 请求统一代理到线上 `https://rsshub-balancer.virworks.moe`，首页的上游实例列表与桑基图直接使用云端真实数据；开发首页时无需启动本地后端或配置 Cloudflare 查询凭据。此代理仅用于 Vite 开发服务；验证本地内部接口代码时，应直接请求本地后端接口。

插件默认启用 Remote bindings 支持，支持远程连接的具体资源在 `wrangler.jsonc` 中配置 `remote: true`；Worker 代码仍在本机 workerd 执行。当前 `METRICS` 的 Analytics Engine 不支持远程绑定，使用本地模拟；Redis 由 SDK 直连 `apps/edge/.dev.vars` 中的 `VALKEY_URL`。资源支持范围见 [Cloudflare 开发模式支持表](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)。

`pnpm build:edge` 先构建首页，再通过 [Worker Vite 配置](apps/edge/vite.config.ts) 和官方 Cloudflare 插件生成 `dist/apps/edge/server/index.js`、独立 Redis SDK 模块及 `public/` 静态资源。Worker 开启 `new_module_registry`，首次访问 Redis 时才导入 SDK，ingest 不加载它；模块缓存不会复用 Redis 连接。`pnpm deploy:edge`（兼容命令 `pnpm deploy`）先构建，再使用生成的 `server/wrangler.json` 发布，保留 `no_bundle` 和模块规则，避免再次合包；Worker 与首页仍一起发布。

Node 收到终止信号后直接退出，允许中断未完成请求并丢失未上传指标。Docker 运行时使用 `--init`，Compose 设置 `init: true`，由轻量 init 转发信号，避免 Node 直接作为 PID 1 忽略停止信号。发布与回滚约定见 [Node 源站发布策略](docs/origin-release-strategy.md)。

### Origin 镜像 CI

[Origin image 工作流](.github/workflows/origin-image.yml) 仅在向 `main` 推送 Node 相关变更时触发：Node 应用、共享后端、workspace 依赖清单、锁文件及构建/检查配置。仅修改 edge、watchdog 或 web 源码及文档不会触发；修改它们的 `package.json` 或公共锁文件会触发，因为 Docker 安装依赖会读取这些文件。

CI 先执行 Node 与共享后端的类型检查和 lint，通过后使用现有 Dockerfile 构建 `linux/amd64`、`linux/arm64` 镜像并推送到 `ghcr.io/chesha1/rsshub-balancer`，生成 `sha-<完整提交 SHA>` 和 `latest` 标签。PR 不触发工作流，也不提供手动触发入口。

发布使用 GitHub 自动提供的 `GITHUB_TOKEN` 和工作流声明的 `packages: write`，无需另配仓库推送密码。首次发布后检查 GHCR 包的可见性：公开包可匿名拉取，私有包需要服务器使用有 `read:packages` 权限的凭据登录。具体依据见 [GitHub 容器仓库文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

成功发布的 Actions 摘要会列出版本标签及 `ghcr.io/chesha1/rsshub-balancer@sha256:...`。部署优先记录并使用 digest；同一提交重跑可能因 Node/pnpm 大版本内更新产生不同镜像，SHA 标签仍可能被覆盖。CI 不清理历史镜像，保留正在使用和回滚所需的 digest。服务器更新按[运行与接管](#运行与接管)手动执行。
