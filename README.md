# rsshub-balancer
Load balance across multiple RSSHub instances to reuse cached responses and reduce redundant crawling 为多个 RSSHub 实例做负载均衡，复用缓存响应，减少重复抓取

## 开发

```txt
pnpm install
```

本地开发通常需要分别启动后端 Worker 和首页前端：

```txt
pnpm run dev:server
pnpm run dev:web
```

`dev:server` 使用 `apps/server/wrangler.jsonc` 启动 Cloudflare Worker，负责 RSSHub 转发、`/_internal/*` 数据接口、健康检查和状态存储访问。本地开发 secret 按 Wrangler 默认规则放在 `apps/server/.dev.vars`。

`dev:web` 启动 Vite 首页开发服务，并把 `/_internal/*`、`/api/*`、`/healthz`、`/robots.txt` 代理到本地 Worker。

## 常用命令

```txt
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
pnpm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// apps/server/src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

## Monorepo

本仓库使用 `pnpm workspaces + Nx`：

- `apps/server`：Cloudflare Worker / Hono 后端，负责 RSSHub 转发、DO、状态存储、metrics 写入和 `/_internal/*` UI 数据接口。
- `apps/web`：Vue3 / Vite 首页，构建输出到 `dist/apps/web`，由 Worker Static Assets 托管。
- `docs`：根目录文档。

## Analytics Engine metrics

合并收益统计写入 Workers Analytics Engine 数据集 `rsshub_balancer_metrics`。指标是近似统计，查询时需要使用 `_sample_interval` 修正采样。

首页桑基图会由 Worker 代理查询 Workers Analytics Engine SQL API，需要配置两个 Worker secrets：

- `CLOUDFLARE_ACCOUNT_ID`：当前数据集所在的 Cloudflare Account ID。
- `CLOUDFLARE_ANALYTICS_API_TOKEN`：只读 Analytics token，权限为 `Account / Account Analytics / Read`，建议 token name 为 `rsshub-balancer-analytics-read`。

本地开发时把这两个值写入 `apps/server/.dev.vars`；生产环境通过 Wrangler secret 写入 Cloudflare。

```txt
pnpm exec wrangler secret put CLOUDFLARE_ACCOUNT_ID --config apps/server/wrangler.jsonc
pnpm exec wrangler secret put CLOUDFLARE_ANALYTICS_API_TOKEN --config apps/server/wrangler.jsonc
```

Metrics 查询 SQL 见 [docs/metrics.md](docs/metrics.md)。

## 项目边界

本项目定位为 RSSHub 场景下的轻量 HTTP L7 路由与请求合并器，不会继续扩展成完整软件负载均衡器。能力边界和后续维护方向见 [docs/capability-boundary.md](docs/capability-boundary.md)。
