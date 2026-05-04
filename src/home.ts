import { html, raw } from 'hono/html'

export function renderHome(upstreams: string[]) {
  const upstreamList = upstreams
    .map((u) => `<li><a href="${u}" target="_blank">${u}</a></li>`)
    .join('\n')
  return html`<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RSSHub Balancer</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #333; }
    h1 { margin-bottom: 0.25rem; }
    ul { padding-left: 1.5rem; list-style: disc; }
    li { margin: 0.25rem 0; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .note { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 0.75rem 1rem; margin-top: 1.5rem; }
    hr { border: none; border-top: 1px solid #d0d7de; margin: 2rem 0; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.9rem; }
    th, td { border: 1px solid #d0d7de; padding: 0.4rem 0.6rem; text-align: left; }
    th { background: #f6f8fa; }
    code { background: #eff1f3; padding: 0.15rem 0.35rem; border-radius: 3px; font-size: 0.85em; }
  </style>
</head>
<body>
  <h1>RSSHub Balancer</h1>
  <p>为多个 RSSHub 实例做负载均衡，复用缓存响应，减少重复抓取。</p>

  <h2>当前上游实例</h2>
  <p>以下实例自动从 <a href="https://docs.rsshub.app/guide/instances" target="_blank">RSSHub 官方文档</a>同步，另包含一个自维护的兜底实例。</p>
  <ul>
    ${raw(upstreamList)}
  </ul>

  <h2>工作原理</h2>
  <p>本负载均衡器<strong>不会</strong>对上游 RSSHub 实例或被爬取的原始网站造成额外负担：</p>
  <ul>
    <li><strong>两级请求合并</strong> —— 同一时刻对同一路由的多个并发请求会被合并为一次上游请求。第一级在 Worker isolate 内部，共享同一个 Promise；第二级通过 Durable Object 跨 isolate 合并，确保全局只有一个请求发往上游。无论有多少用户同时请求相同的 RSS 源，上游实例只收到一次请求。</li>
    <li><strong>缓存感知路由</strong> —— 在向上游发起实际请求前，先并行检查各实例是否已缓存该路由。优先将请求转发给已有缓存的实例，由其直接返回缓存内容，无需重新抓取原始网站。</li>
    <li><strong>不影响原始网站</strong> —— 每个 RSSHub 实例都有自己的缓存和抓取调度。本均衡器只在 RSSHub 实例层面做分发，从不直接抓取原始网站，也不会改变任何实例的抓取频率。</li>
  </ul>

  <h2>接口兼容性</h2>
  <p>与 RSSHub 原始接口的差异如下：</p>
  <table>
    <tr><th>路径</th><th>状态</th><th>说明</th></tr>
    <tr><td><code>/:namespace/:path</code></td><td>✅ 负载均衡</td><td>核心 Feed 路由，经两级请求合并后转发上游</td></tr>
    <tr><td><code>/</code></td><td>✅ 自定义</td><td>本页面，替代 RSSHub 原始首页</td></tr>
    <tr><td><code>/healthz</code></td><td>✅ 自定义</td><td>聚合检查所有上游实例健康状态</td></tr>
    <tr><td><code>/robots.txt</code></td><td>✅ 自定义</td><td>禁止所有搜索引擎索引</td></tr>
    <tr><td><code>/api/route/status</code></td><td>✅ 聚合代理</td><td>查询任一上游是否已缓存指定路由</td></tr>
    <tr><td><code>/metrics</code></td><td>🚫 未开放</td><td>合并收益指标写入 Workers Analytics Engine，通过 SQL API 查询</td></tr>
    <tr><td><code>/api/openapi.json</code></td><td>❌ 不可用</td><td>API 文档请直接访问上游实例</td></tr>
    <tr><td><code>/api/reference</code></td><td>❌ 不可用</td><td>交互式 API 文档 UI</td></tr>
    <tr><td><code>/api/namespace, /api/namespace/*</code></td><td>❌ 不可用</td><td>命名空间元数据查询</td></tr>
    <tr><td><code>/api/category/*</code></td><td>❌ 不可用</td><td>分类查询</td></tr>
    <tr><td><code>/api/radar/rules, /api/radar/rules/*</code></td><td>❌ 不可用</td><td>Radar 规则查询</td></tr>
    <tr><td><code>/api/follow/config</code></td><td>❌ 不可用</td><td>Follow 实例配置</td></tr>
    <tr><td><code>/api/:namespace/:path</code></td><td>❌ 不可用</td><td>业务 JSON API（apiRoute）</td></tr>
  </table>

  <div class="note">
    <p><strong>想要添加或移除你维护的实例？</strong></p>
    <p>请在 <a href="https://github.com/chesha1/rsshub-balancer/issues" target="_blank">GitHub 仓库</a> 提交 Issue。</p>
  </div>

  <hr />

  <h1>RSSHub Balancer</h1>
  <p>Load balancer for multiple RSSHub instances — reuses cached responses and reduces redundant fetching.</p>

  <h2>Current Upstreams</h2>
  <p>Instances below are automatically synced from the <a href="https://docs.rsshub.app/guide/instances" target="_blank">official RSSHub documentation</a>, plus one self-maintained standby instance.</p>
  <ul>
    ${raw(upstreamList)}
  </ul>

  <h2>How It Works</h2>
  <p>This load balancer does <strong>not</strong> impose extra burden on upstream RSSHub instances or the original websites being crawled:</p>
  <ul>
    <li><strong>Two-level request coalescing</strong> — Concurrent requests for the same route are merged into a single upstream request. The first level deduplicates within a Worker isolate by sharing the same Promise; the second level uses a Durable Object to coalesce across isolates, ensuring only one request reaches the upstream globally. No matter how many users request the same RSS feed at the same time, the upstream instance only receives one request.</li>
    <li><strong>Cache-aware routing</strong> — Before making an actual request, the balancer checks all upstream instances in parallel to find one that has already cached the route. The request is then forwarded to the cached instance, which serves its cached content without re-crawling the source website.</li>
    <li><strong>No impact on original websites</strong> — Each RSSHub instance maintains its own cache and crawl schedule. This balancer only distributes requests at the RSSHub instance level; it never crawls original websites directly, nor does it alter any instance's crawl frequency.</li>
  </ul>

  <h2>Endpoint Compatibility</h2>
  <p>Differences from the original RSSHub endpoints:</p>
  <table>
    <tr><th>Path</th><th>Status</th><th>Notes</th></tr>
    <tr><td><code>/:namespace/:path</code></td><td>✅ Load balanced</td><td>Core feed routes, forwarded via two-level request coalescing</td></tr>
    <tr><td><code>/</code></td><td>✅ Custom</td><td>This page, replaces the original RSSHub homepage</td></tr>
    <tr><td><code>/healthz</code></td><td>✅ Custom</td><td>Aggregated health check across all upstreams</td></tr>
    <tr><td><code>/robots.txt</code></td><td>✅ Custom</td><td>Disallows all search engine indexing</td></tr>
    <tr><td><code>/api/route/status</code></td><td>✅ Aggregated proxy</td><td>Checks if any upstream has cached the given route</td></tr>
    <tr><td><code>/metrics</code></td><td>🚫 Not public</td><td>Coalescing benefit metrics are written to Workers Analytics Engine and queried through the SQL API</td></tr>
    <tr><td><code>/api/openapi.json</code></td><td>❌ Unavailable</td><td>API docs — visit an upstream instance directly</td></tr>
    <tr><td><code>/api/reference</code></td><td>❌ Unavailable</td><td>Interactive API docs UI</td></tr>
    <tr><td><code>/api/namespace, /api/namespace/*</code></td><td>❌ Unavailable</td><td>Namespace metadata queries</td></tr>
    <tr><td><code>/api/category/*</code></td><td>❌ Unavailable</td><td>Category queries</td></tr>
    <tr><td><code>/api/radar/rules, /api/radar/rules/*</code></td><td>❌ Unavailable</td><td>Radar rule queries</td></tr>
    <tr><td><code>/api/follow/config</code></td><td>❌ Unavailable</td><td>Follow instance configuration</td></tr>
    <tr><td><code>/api/:namespace/:path</code></td><td>❌ Unavailable</td><td>Business JSON API (apiRoute)</td></tr>
  </table>

  <div class="note">
    <p><strong>Want to add or remove your instance?</strong></p>
    <p>Please open an issue on the <a href="https://github.com/chesha1/rsshub-balancer/issues" target="_blank">GitHub repository</a>.</p>
  </div>
</body>
</html>`
}
