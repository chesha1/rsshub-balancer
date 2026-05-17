<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { setAppLocale } from './i18n'
import TrafficSankeyChart from './TrafficSankeyChart.vue'
import {
  trafficSankeyResponseSchema,
  type TrafficSankeyLink,
  upstreamsResponseSchema,
} from './types'

type LoadState = 'loading' | 'ready' | 'error'

type CompatibilityRow = {
  path: string
  statusKey: string
  notesKey: string
}

const compatibilityRows: CompatibilityRow[] = [
  {
    path: '/:namespace/:path',
    statusKey: 'compatibility.rows.feed.status',
    notesKey: 'compatibility.rows.feed.notes',
  },
  {
    path: '/',
    statusKey: 'compatibility.rows.home.status',
    notesKey: 'compatibility.rows.home.notes',
  },
  {
    path: '/healthz',
    statusKey: 'compatibility.rows.healthz.status',
    notesKey: 'compatibility.rows.healthz.notes',
  },
  {
    path: '/robots.txt',
    statusKey: 'compatibility.rows.robots.status',
    notesKey: 'compatibility.rows.robots.notes',
  },
  {
    path: '/api/route/status',
    statusKey: 'compatibility.rows.routeStatus.status',
    notesKey: 'compatibility.rows.routeStatus.notes',
  },
  {
    path: '/metrics',
    statusKey: 'compatibility.rows.metrics.status',
    notesKey: 'compatibility.rows.metrics.notes',
  },
  {
    path: '/api/openapi.json',
    statusKey: 'compatibility.rows.openapi.status',
    notesKey: 'compatibility.rows.openapi.notes',
  },
  {
    path: '/api/reference',
    statusKey: 'compatibility.rows.reference.status',
    notesKey: 'compatibility.rows.reference.notes',
  },
  {
    path: '/api/namespace, /api/namespace/*',
    statusKey: 'compatibility.rows.namespace.status',
    notesKey: 'compatibility.rows.namespace.notes',
  },
  {
    path: '/api/category/*',
    statusKey: 'compatibility.rows.category.status',
    notesKey: 'compatibility.rows.category.notes',
  },
  {
    path: '/api/radar/rules, /api/radar/rules/*',
    statusKey: 'compatibility.rows.radar.status',
    notesKey: 'compatibility.rows.radar.notes',
  },
  {
    path: '/api/follow/config',
    statusKey: 'compatibility.rows.follow.status',
    notesKey: 'compatibility.rows.follow.notes',
  },
  {
    path: '/api/:namespace/:path',
    statusKey: 'compatibility.rows.apiRoute.status',
    notesKey: 'compatibility.rows.apiRoute.notes',
  },
]

const upstreams = ref<string[]>([])
const upstreamsLoadState = ref<LoadState>('loading')
const trafficSankeyLinks = ref<TrafficSankeyLink[]>([])
const trafficSankeyLoadState = ref<LoadState>('loading')
const { t, locale } = useI18n()

const languageButtonLabel = computed(() =>
  locale.value === 'zh-CN' ? 'English' : '中文',
)

// 切换当前前端语言，并把选择持久化到浏览器本地状态。
function switchLocale() {
  const nextLocale = locale.value === 'zh-CN' ? 'en-US' : 'zh-CN'
  setAppLocale(nextLocale)
}

// 从公开 UI 数据接口加载实例列表；失败时只影响首页展示，不改变路由行为。
async function loadUpstreams() {
  upstreamsLoadState.value = 'loading'

  try {
    const response = await fetch('/_internal/upstreams', {
      headers: {
        Accept: 'application/json',
      },
    })
    if (!response.ok) {
      throw new Error(`upstreams request failed: ${response.status}`)
    }

    const payload = upstreamsResponseSchema.parse(await response.json())
    upstreams.value = payload.upstreams
    upstreamsLoadState.value = 'ready'
  } catch {
    upstreams.value = []
    upstreamsLoadState.value = 'error'
  }
}

// 从公开 UI 数据接口加载最近 24 小时的 country -> edge colo 聚合数据。
async function loadTrafficSankey() {
  trafficSankeyLoadState.value = 'loading'

  try {
    const response = await fetch('/_internal/metrics/country-colo-sankey', {
      headers: {
        Accept: 'application/json',
      },
    })
    if (!response.ok) {
      throw new Error(`traffic sankey request failed: ${response.status}`)
    }

    const payload = trafficSankeyResponseSchema.parse(await response.json())
    trafficSankeyLinks.value = payload.links
    trafficSankeyLoadState.value = 'ready'
  } catch {
    trafficSankeyLinks.value = []
    trafficSankeyLoadState.value = 'error'
  }
}

onMounted(async () => {
  await Promise.all([loadUpstreams(), loadTrafficSankey()])
})
</script>

<template>
  <main class="page-shell">
    <div class="page-toolbar">
      <button
        class="language-toggle"
        type="button"
        :aria-label="t('language.switchAria')"
        @click="switchLocale"
      >
        {{ languageButtonLabel }}
      </button>
    </div>

    <section class="language-section" aria-labelledby="page-title">
      <h1 id="page-title">{{ t('hero.title') }}</h1>
      <p>{{ t('hero.summary') }}</p>

      <h2>{{ t('upstreams.title') }}</h2>
      <p>
        <span>{{ t('upstreams.introBefore') }}</span>
        <a
          href="https://docs.rsshub.app/guide/instances"
          target="_blank"
          rel="noreferrer"
        >
          {{ t('upstreams.docsLink') }}
        </a>
        <span>{{ t('upstreams.introAfter') }}</span>
      </p>
      <p v-if="upstreamsLoadState === 'loading'" class="muted">
        {{ t('upstreams.loading') }}
      </p>
      <p v-else-if="upstreamsLoadState === 'error'" class="muted">
        {{ t('upstreams.error') }}
      </p>
      <ul v-else>
        <li v-for="upstream in upstreams" :key="upstream">
          <a :href="upstream" target="_blank" rel="noreferrer">{{ upstream }}</a>
        </li>
      </ul>

      <h2>{{ t('trafficSankey.title') }}</h2>
      <p>{{ t('trafficSankey.summary') }}</p>
      <p v-if="trafficSankeyLoadState === 'loading'" class="muted">
        {{ t('trafficSankey.loading') }}
      </p>
      <p v-else-if="trafficSankeyLoadState === 'error'" class="muted">
        {{ t('trafficSankey.error') }}
      </p>
      <p v-else-if="trafficSankeyLinks.length === 0" class="muted">
        {{ t('trafficSankey.empty') }}
      </p>
      <TrafficSankeyChart v-else :links="trafficSankeyLinks" />

      <h2>{{ t('howItWorks.title') }}</h2>
      <p>
        <span>{{ t('howItWorks.introBefore') }}</span>
        <strong>{{ t('howItWorks.introStrong') }}</strong>
        <span>{{ t('howItWorks.introAfter') }}</span>
      </p>
      <ul>
        <li>
          <strong>{{ t('howItWorks.coalescing.title') }}</strong>
          {{ t('howItWorks.coalescing.summary') }}
          {{ t('howItWorks.coalescing.cost') }}
          {{ t('howItWorks.coalescing.current') }}
        </li>
        <li>
          <strong>{{ t('howItWorks.cacheAware.title') }}</strong>
          {{ t('howItWorks.cacheAware.body') }}
        </li>
        <li>
          <strong>{{ t('howItWorks.noImpact.title') }}</strong>
          {{ t('howItWorks.noImpact.body') }}
        </li>
      </ul>

      <h2>{{ t('compatibility.title') }}</h2>
      <p>{{ t('compatibility.summary') }}</p>
      <table>
        <thead>
          <tr>
            <th>{{ t('compatibility.headers.path') }}</th>
            <th>{{ t('compatibility.headers.status') }}</th>
            <th>{{ t('compatibility.headers.notes') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in compatibilityRows" :key="row.path">
            <td>
              <code>{{ row.path }}</code>
            </td>
            <td>{{ t(row.statusKey) }}</td>
            <td>{{ t(row.notesKey) }}</td>
          </tr>
        </tbody>
      </table>

      <div class="note">
        <p>
          <strong>{{ t('contribute.title') }}</strong>
        </p>
        <p>
          <span>{{ t('contribute.beforeLink') }}</span>
          <a
            href="https://github.com/chesha1/rsshub-balancer/issues"
            target="_blank"
            rel="noreferrer"
          >
            {{ t('contribute.link') }}
          </a>
          <span>{{ t('contribute.afterLink') }}</span>
        </p>
      </div>
    </section>
  </main>
</template>
