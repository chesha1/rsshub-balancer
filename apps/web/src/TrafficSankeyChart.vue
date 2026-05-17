<script setup lang="ts">
import { SankeyChart } from 'echarts/charts'
import { TooltipComponent } from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import VChart from 'vue-echarts'
import type { TrafficSankeyLink } from './types'

type TooltipData = {
  name?: unknown
  source?: unknown
  target?: unknown
  value?: unknown
}

type TooltipParams = {
  data?: unknown
  name?: unknown
  value?: unknown
}

const props = defineProps<{
  links: TrafficSankeyLink[]
}>()

const { t } = useI18n()
const chartAriaLabel = computed(() => t('trafficSankey.chartAria'))
const requestCountLabel = computed(() => t('trafficSankey.tooltipRequests'))

use([CanvasRenderer, SankeyChart, TooltipComponent])

// 判断未知 tooltip 数据是否是对象，避免 formatter 里直接信任第三方库参数。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// 给两侧节点加命名空间，避免 country 和 colo 中的相同文本被 ECharts 合并成一个节点。
function createNodeName(kind: 'country' | 'colo', value: string) {
  return `${kind}:${value}`
}

// 移除内部命名空间，只把用户可读的国家/地区或机房代码展示在图上。
function formatNodeName(name: string) {
  const separatorIndex = name.indexOf(':')
  return separatorIndex === -1 ? name : name.slice(separatorIndex + 1)
}

// 格式化请求数，尽量保留 Analytics Engine 聚合后的整数阅读体验。
function formatRequestCount(value: unknown) {
  const numericValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numericValue)) return '0'

  return Math.round(numericValue).toLocaleString()
}

// 对 tooltip 文本做最小 HTML 转义，避免外部维度值进入 HTML formatter。
function escapeTooltipText(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// 为节点和连线生成可读 tooltip，连线显示 source -> target 和请求数。
function formatTooltip(params: unknown) {
  if (!isRecord(params)) return ''

  const tooltipParams = params as TooltipParams
  const data: TooltipData = isRecord(tooltipParams.data)
    ? tooltipParams.data
    : {}

  if (typeof data.source === 'string' && typeof data.target === 'string') {
    const source = escapeTooltipText(formatNodeName(data.source))
    const target = escapeTooltipText(formatNodeName(data.target))
    const label = escapeTooltipText(requestCountLabel.value)
    return `${source} -> ${target}<br/>${label}: ${formatRequestCount(data.value)}`
  }

  const name =
    typeof data.name === 'string'
      ? data.name
      : typeof tooltipParams.name === 'string'
        ? tooltipParams.name
        : ''
  const label = escapeTooltipText(requestCountLabel.value)
  const nodeName = escapeTooltipText(formatNodeName(name))
  return `${nodeName}<br/>${label}: ${formatRequestCount(tooltipParams.value)}`
}

const chartOption = computed(() => {
  const nodeNames = new Set<string>()
  const links = props.links.map((link) => {
    const source = createNodeName('country', link.source)
    const target = createNodeName('colo', link.target)
    nodeNames.add(source)
    nodeNames.add(target)

    return {
      source,
      target,
      value: link.value,
    }
  })

  return {
    animationDuration: 400,
    color: ['#0969da', '#1f883d', '#8250df', '#bf8700', '#cf222e', '#0a3069'],
    tooltip: {
      trigger: 'item',
      formatter: formatTooltip,
    },
    series: [
      {
        type: 'sankey',
        data: Array.from(nodeNames, (name) => ({ name })),
        links,
        draggable: false,
        nodeAlign: 'justify',
        nodeGap: 10,
        nodeWidth: 14,
        top: 12,
        right: 16,
        bottom: 12,
        left: 16,
        label: {
          color: '#24292f',
          formatter: (params: { name: string }) => formatNodeName(params.name),
          fontSize: 12,
        },
        lineStyle: {
          color: 'gradient',
          curveness: 0.5,
          opacity: 0.35,
        },
        emphasis: {
          focus: 'adjacency',
          lineStyle: {
            opacity: 0.65,
          },
        },
      },
    ],
  }
})
</script>

<template>
  <VChart
    class="traffic-sankey-chart"
    :aria-label="chartAriaLabel"
    :option="chartOption"
    autoresize
    role="img"
  />
</template>
