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
