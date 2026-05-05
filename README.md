# rsshub-balancer
Load balance across multiple RSSHub instances to reuse cached responses and reduce redundant crawling 为多个 RSSHub 实例做负载均衡，复用缓存响应，减少重复抓取

## hono
```txt
pnpm install
pnpm run dev
```

```txt
pnpm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
pnpm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

## Analytics Engine metrics

合并收益统计写入 Workers Analytics Engine 数据集 `rsshub_balancer_metrics`。指标是近似统计，查询时需要使用 `_sample_interval` 修正采样。

Metrics 查询 SQL 见 [docs/metrics.md](docs/metrics.md)。

## 项目边界

本项目定位为 RSSHub 场景下的轻量 HTTP L7 路由与请求合并器，不会继续扩展成完整软件负载均衡器。能力边界和后续维护方向见 [docs/capability-boundary.md](docs/capability-boundary.md)。
