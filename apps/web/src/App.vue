<script setup lang="ts">
import { onMounted, ref } from 'vue'

type LoadState = 'loading' | 'ready' | 'error'

type CompatibilityRow = {
  path: string
  status: string
  notes: string
}

const upstreams = ref<string[]>([])
const loadState = ref<LoadState>('loading')

const compatibilityRowsZh: CompatibilityRow[] = [
  {
    path: '/:namespace/:path',
    status: '✅ 负载均衡',
    notes: '核心 Feed 路由，经两级请求合并后转发上游',
  },
  {
    path: '/',
    status: '✅ 自定义',
    notes: '本页面，替代 RSSHub 原始首页',
  },
  {
    path: '/healthz',
    status: '✅ 自定义',
    notes: '聚合检查所有上游实例健康状态',
  },
  {
    path: '/robots.txt',
    status: '✅ 自定义',
    notes: '禁止所有搜索引擎索引',
  },
  {
    path: '/api/route/status',
    status: '✅ 聚合代理',
    notes: '查询任一上游是否已缓存指定路由',
  },
  {
    path: '/metrics',
    status: '🚫 未开放',
    notes: '合并收益指标写入 Workers Analytics Engine，通过 SQL API 查询',
  },
  {
    path: '/api/openapi.json',
    status: '❌ 不可用',
    notes: 'API 文档请直接访问上游实例',
  },
  {
    path: '/api/reference',
    status: '❌ 不可用',
    notes: '交互式 API 文档 UI',
  },
  {
    path: '/api/namespace, /api/namespace/*',
    status: '❌ 不可用',
    notes: '命名空间元数据查询',
  },
  {
    path: '/api/category/*',
    status: '❌ 不可用',
    notes: '分类查询',
  },
  {
    path: '/api/radar/rules, /api/radar/rules/*',
    status: '❌ 不可用',
    notes: 'Radar 规则查询',
  },
  {
    path: '/api/follow/config',
    status: '❌ 不可用',
    notes: 'Follow 实例配置',
  },
  {
    path: '/api/:namespace/:path',
    status: '❌ 不可用',
    notes: '业务 JSON API（apiRoute）',
  },
]

const compatibilityRowsEn: CompatibilityRow[] = [
  {
    path: '/:namespace/:path',
    status: '✅ Load balanced',
    notes: 'Core feed routes, forwarded via two-level request coalescing',
  },
  {
    path: '/',
    status: '✅ Custom',
    notes: 'This page, replaces the original RSSHub homepage',
  },
  {
    path: '/healthz',
    status: '✅ Custom',
    notes: 'Aggregated health check across all upstreams',
  },
  {
    path: '/robots.txt',
    status: '✅ Custom',
    notes: 'Disallows all search engine indexing',
  },
  {
    path: '/api/route/status',
    status: '✅ Aggregated proxy',
    notes: 'Checks if any upstream has cached the given route',
  },
  {
    path: '/metrics',
    status: '🚫 Not public',
    notes:
      'Coalescing benefit metrics are written to Workers Analytics Engine and queried through the SQL API',
  },
  {
    path: '/api/openapi.json',
    status: '❌ Unavailable',
    notes: 'API docs — visit an upstream instance directly',
  },
  {
    path: '/api/reference',
    status: '❌ Unavailable',
    notes: 'Interactive API docs UI',
  },
  {
    path: '/api/namespace, /api/namespace/*',
    status: '❌ Unavailable',
    notes: 'Namespace metadata queries',
  },
  {
    path: '/api/category/*',
    status: '❌ Unavailable',
    notes: 'Category queries',
  },
  {
    path: '/api/radar/rules, /api/radar/rules/*',
    status: '❌ Unavailable',
    notes: 'Radar rule queries',
  },
  {
    path: '/api/follow/config',
    status: '❌ Unavailable',
    notes: 'Follow instance configuration',
  },
  {
    path: '/api/:namespace/:path',
    status: '❌ Unavailable',
    notes: 'Business JSON API (apiRoute)',
  },
]

// 从公开 UI 数据接口加载实例列表；失败时只影响首页展示，不改变路由行为。
async function loadUpstreams() {
  loadState.value = 'loading'

  try {
    const response = await fetch('/_internal/upstreams', {
      headers: {
        Accept: 'application/json',
      },
    })
    if (!response.ok) {
      throw new Error(`upstreams request failed: ${response.status}`)
    }

    const payload = (await response.json()) as { upstreams?: unknown }
    if (!Array.isArray(payload.upstreams)) {
      throw new Error('upstreams response shape invalid')
    }

    upstreams.value = payload.upstreams.filter(
      (upstream): upstream is string => typeof upstream === 'string',
    )
    loadState.value = 'ready'
  } catch {
    upstreams.value = []
    loadState.value = 'error'
  }
}

onMounted(loadUpstreams)
</script>

<template>
  <main class="page-shell">
    <section class="language-section" aria-labelledby="title-zh">
      <h1 id="title-zh">RSSHub Balancer</h1>
      <p>为多个 RSSHub 实例做负载均衡，复用缓存响应，减少重复抓取。</p>

      <h2>当前上游实例</h2>
      <p>
        以下实例自动从
        <a
          href="https://docs.rsshub.app/guide/instances"
          target="_blank"
          rel="noreferrer"
        >
          RSSHub 官方文档
        </a>
        同步，另包含一个自维护的兜底实例。
      </p>
      <p v-if="loadState === 'loading'" class="muted">正在加载当前实例列表…</p>
      <p v-else-if="loadState === 'error'" class="muted">当前实例列表暂时不可用。</p>
      <ul v-else>
        <li v-for="upstream in upstreams" :key="`zh-${upstream}`">
          <a :href="upstream" target="_blank" rel="noreferrer">{{ upstream }}</a>
        </li>
      </ul>

      <h2>工作原理</h2>
      <p>
        本负载均衡器<strong>不会</strong>对上游 RSSHub 实例或被爬取的原始网站造成额外负担：
      </p>
      <ul>
        <li>
          <strong>两级请求合并</strong> —— 同一时刻对同一路由的多个并发请求会先在
          Worker isolate 内共享同一个 Promise，尽量合并为一次上游请求。Durable Objects
          原本用于跨 isolate 合并，但目前成本过高，已经触发过两次 12.50
          美元扣费；分析后发现额外收益很小，所以暂时只有约 1%
          符合条件的请求会尝试进入 Durable Object，其余请求会直接走 isolate
          合并与上游转发。
        </li>
        <li>
          <strong>缓存感知路由</strong> ——
          在向上游发起实际请求前，先并行检查各实例是否已缓存该路由。优先将请求转发给已有缓存的实例，由其直接返回缓存内容，无需重新抓取原始网站。
        </li>
        <li>
          <strong>不影响原始网站</strong> —— 每个 RSSHub
          实例都有自己的缓存和抓取调度。本均衡器只在 RSSHub
          实例层面做分发，从不直接抓取原始网站，也不会改变任何实例的抓取频率。
        </li>
      </ul>

      <h2>接口兼容性</h2>
      <p>与 RSSHub 原始接口的差异如下：</p>
      <table>
        <thead>
          <tr>
            <th>路径</th>
            <th>状态</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in compatibilityRowsZh" :key="`zh-${row.path}`">
            <td>
              <code>{{ row.path }}</code>
            </td>
            <td>{{ row.status }}</td>
            <td>{{ row.notes }}</td>
          </tr>
        </tbody>
      </table>

      <div class="note">
        <p><strong>想要添加或移除你维护的实例？</strong></p>
        <p>
          请在
          <a
            href="https://github.com/chesha1/rsshub-balancer/issues"
            target="_blank"
            rel="noreferrer"
          >
            GitHub 仓库
          </a>
          提交 Issue。
        </p>
      </div>
    </section>

    <hr />

    <section class="language-section" aria-labelledby="title-en">
      <h1 id="title-en">RSSHub Balancer</h1>
      <p>
        Load balancer for multiple RSSHub instances — reuses cached responses and reduces redundant
        fetching.
      </p>

      <h2>Current Upstreams</h2>
      <p>
        Instances below are automatically synced from the
        <a
          href="https://docs.rsshub.app/guide/instances"
          target="_blank"
          rel="noreferrer"
        >
          official RSSHub documentation</a
        >, plus one self-maintained standby instance.
      </p>
      <p v-if="loadState === 'loading'" class="muted">Loading current upstreams…</p>
      <p v-else-if="loadState === 'error'" class="muted">
        The current upstream list is temporarily unavailable.
      </p>
      <ul v-else>
        <li v-for="upstream in upstreams" :key="`en-${upstream}`">
          <a :href="upstream" target="_blank" rel="noreferrer">{{ upstream }}</a>
        </li>
      </ul>

      <h2>How It Works</h2>
      <p>
        This load balancer does <strong>not</strong> impose extra burden on upstream RSSHub instances
        or the original websites being crawled:
      </p>
      <ul>
        <li>
          <strong>Two-level request coalescing</strong> — Concurrent requests for the same route first
          share the same Promise within a Worker isolate, so most duplicate traffic is merged there.
          Durable Objects were originally used for cross-isolate coalescing, but the current cost is
          too high: they have triggered two $12.50 charges. After analysis, the extra benefit is
          small, so only about 1% of eligible requests currently attempt to enter the Durable Object;
          the rest use isolate-level coalescing and direct upstream forwarding.
        </li>
        <li>
          <strong>Cache-aware routing</strong> — Before making an actual request, the balancer checks
          all upstream instances in parallel to find one that has already cached the route. The request
          is then forwarded to the cached instance, which serves its cached content without re-crawling
          the source website.
        </li>
        <li>
          <strong>No impact on original websites</strong> — Each RSSHub instance maintains its own
          cache and crawl schedule. This balancer only distributes requests at the RSSHub instance
          level; it never crawls original websites directly, nor does it alter any instance's crawl
          frequency.
        </li>
      </ul>

      <h2>Endpoint Compatibility</h2>
      <p>Differences from the original RSSHub endpoints:</p>
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>Status</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in compatibilityRowsEn" :key="`en-${row.path}`">
            <td>
              <code>{{ row.path }}</code>
            </td>
            <td>{{ row.status }}</td>
            <td>{{ row.notes }}</td>
          </tr>
        </tbody>
      </table>

      <div class="note">
        <p><strong>Want to add or remove your instance?</strong></p>
        <p>
          Please open an issue on the
          <a
            href="https://github.com/chesha1/rsshub-balancer/issues"
            target="_blank"
            rel="noreferrer"
          >
            GitHub repository</a
          >.
        </p>
      </div>
    </section>
  </main>
</template>
