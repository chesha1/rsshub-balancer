<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { getNextLocale, localeNames, setAppLocale } from './i18n'
import {
  preloadTrafficSankeyChart,
  TrafficSankeyChart,
} from './trafficSankeyChartLoader'
import {
  type TrafficSankeyRow,
  trafficSankeyResponseSchema,
  upstreamsResponseSchema,
} from './types'

type LoadState = 'loading' | 'ready' | 'error'

// id 对应语言包中 compatibility.rows 下的键，每行的状态和说明文案都从该键下读取。
type CompatibilityRow = {
  id: string
  path: string
}

const compatibilityRows: CompatibilityRow[] = [
  { id: 'feed', path: '/:namespace/:path' },
  // 首页、静态资源和 robots.txt 都由本站处理、不转发到上游，合并为一条说明。
  { id: 'site', path: '/, /_assets/*, /favicon.ico, /robots.txt' },
  { id: 'healthz', path: '/healthz' },
  { id: 'routeStatus', path: '/api/route/status' },
  // 其余 RSSHub API 在共享路由中统一返回 404，首页只保留一条汇总说明。
  { id: 'api', path: '/api/*' },
  { id: 'metrics', path: '/metrics' },
]

// 接口数据只整体替换 .value，shallowRef 只追踪这一层引用，不为每一行建立响应式代理和字段依赖。
// 原地修改数组或行对象不会触发更新。
const upstreams = shallowRef<string[]>([])
const upstreamsLoadState = ref<LoadState>('loading')
const trafficSankeyRows = shallowRef<TrafficSankeyRow[]>([])
const trafficSankeyLoadState = ref<LoadState>('loading')
const { t } = useI18n()

// 语言按钮显示目标语言的名称，点击后切换到该语言并持久化选择。
const nextLocale = computed(() => getNextLocale())

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

// 从公开 UI 数据接口加载最近 24 小时的首页桑基图四维原始聚合数据。
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
    trafficSankeyRows.value = payload.rows
    trafficSankeyLoadState.value = 'ready'
  } catch {
    trafficSankeyRows.value = []
    trafficSankeyLoadState.value = 'error'
  }
}

onMounted(() => {
  // 三个加载函数都在内部处理失败，这里只负责发起。两个数据请求先发出，图表包随后开始下载；图表等待的是统计请求和图表包中较慢的一项。
  loadUpstreams()
  loadTrafficSankey()
  preloadTrafficSankeyChart()
})
</script>

<template>
  <main class="page-shell">
    <div class="page-toolbar">
      <ElButton
        class="language-toggle"
        native-type="button"
        :aria-label="t('language.switchAria')"
        @click="setAppLocale(nextLocale)"
      >
        {{ localeNames[nextLocale] }}
      </ElButton>
    </div>

    <section aria-labelledby="page-title">
      <h1 id="page-title">{{ t('hero.title') }}</h1>
      <p>{{ t('hero.summary') }}</p>

      <h2>{{ t('usage.title') }}</h2>
      <p>
        <span>{{ t('usage.bodyBeforeExample') }}</span>
        <code>{{ t('usage.exampleRoute') }}</code>
        <span>{{ t('usage.bodyAfterExample') }}</span>
      </p>

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
      <p v-else-if="upstreams.length === 0" class="muted">
        {{ t('upstreams.empty') }}
      </p>
      <ul v-else>
        <li v-for="upstream in upstreams" :key="upstream">
          <a :href="upstream" target="_blank" rel="noreferrer">
            {{ upstream }}
          </a>
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
      <p v-else-if="trafficSankeyRows.length === 0" class="muted">
        {{ t('trafficSankey.empty') }}
      </p>
      <TrafficSankeyChart v-else :rows="trafficSankeyRows" />

      <h2>{{ t('howItWorks.title') }}</h2>
      <p>
        <span>{{ t('howItWorks.introBefore') }}</span>
        <strong>{{ t('howItWorks.introStrong') }}</strong>
        <span>{{ t('howItWorks.introAfter') }}</span>
      </p>
      <ul>
        <li>
          <strong>{{ t('howItWorks.runtime.title') }}</strong>
          {{ t('howItWorks.runtime.body') }}
        </li>
        <li>
          <strong>{{ t('howItWorks.cacheAware.title') }}</strong>
          {{ t('howItWorks.cacheAware.body') }}
        </li>
        <li>
          <strong>{{ t('howItWorks.retry.title') }}</strong>
          {{ t('howItWorks.retry.body') }}
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
          <tr v-for="row in compatibilityRows" :key="row.id">
            <td>
              <code>{{ row.path }}</code>
            </td>
            <td>{{ t(`compatibility.rows.${row.id}.status`) }}</td>
            <td>{{ t(`compatibility.rows.${row.id}.notes`) }}</td>
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
