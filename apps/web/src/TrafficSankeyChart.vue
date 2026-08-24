<script setup lang="ts">
import { schemeSet3, schemeTableau10 } from 'd3-scale-chromatic'
import { SankeyChart } from 'echarts/charts'
import { TooltipComponent } from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import VChart from 'vue-echarts'
import type { TrafficSankeyRow } from './types'

type TrafficSankeyColumn = 'country' | 'edgeColo' | 'outcome' | 'upstream'

type SankeyLink = {
  source: string
  target: string
  value: number
}

type SankeyBuildResult = {
  links: SankeyLink[]
  nodeValues: Map<string, number>
  nodeDepths: Map<string, number>
}

type SankeyPathNode = {
  column: TrafficSankeyColumn
  name: string
}

type SankeyTooltipData = Partial<SankeyLink> & {
  name?: string
  value?: number
}

type SankeyTooltipParams = {
  data?: SankeyTooltipData
  name?: string
  value?: number
}

const props = defineProps<{
  rows: TrafficSankeyRow[]
}>()

const { t, locale } = useI18n()
const trafficSankeyColumns = [
  'country',
  'edgeColo',
  'outcome',
  'upstream',
] as const satisfies readonly TrafficSankeyColumn[]
const selectedColumns = ref<TrafficSankeyColumn[]>([...trafficSankeyColumns])
const outcomeTranslationKeys: Record<string, string> = {
  direct_upstream: 'trafficSankey.outcomeValues.directUpstream',
  do_coalesced: 'trafficSankey.outcomeValues.doCoalesced',
  isolate_coalesced: 'trafficSankey.outcomeValues.isolateCoalesced',
}
const chartAriaLabel = computed(() => t('trafficSankey.chartAria'))
const chartLocaleKey = computed(() => `traffic-sankey-${locale.value}`)
const controlsAriaLabel = computed(() => t('trafficSankey.columnsAria'))
const requestCountLabel = computed(() => t('trafficSankey.tooltipRequests'))
const columnOptions = computed(() =>
  trafficSankeyColumns.map((value) => ({
    value,
    label: t(`trafficSankey.columns.${value}`),
  })),
)
const selectedColumnSet = computed(() => new Set(selectedColumns.value))
const visibleColumns = computed(() =>
  trafficSankeyColumns.filter((column) => selectedColumnSet.value.has(column)),
)

use([CanvasRenderer, SankeyChart, TooltipComponent])

// 使用 D3 维护的分类调色板，避免在图表配置里手写和维护大量颜色。
const sankeyColorPalette = [...schemeTableau10, ...schemeSet3]
const sankeyMinimumChartHeight = 360
const sankeyNodeGap = 16
const sankeyNodeSlotHeight = 22
const sankeyVerticalPadding = 24

// 给每个维度节点加命名空间，避免不同列中相同文本被 ECharts 合并。
function createNodeName(column: TrafficSankeyColumn, value: string) {
  return `${column}:${value}`
}

// 解析内部节点名，让 tooltip 和 label 能拿回维度类型。
function parseNodeName(name: string) {
  const separatorIndex = name.indexOf(':')
  return {
    column: name.slice(0, separatorIndex) as TrafficSankeyColumn,
    value: name.slice(separatorIndex + 1),
  }
}

// 把内部维度值转换成用户可读文本，处理结果维度用当前语言展示。
function formatDimensionValue(column: TrafficSankeyColumn, value: string) {
  if (column === 'outcome') {
    const translationKey = outcomeTranslationKeys[value]
    return translationKey ? t(translationKey) : value
  }

  if (column === 'upstream' && value === 'not_recorded') {
    return t('trafficSankey.upstreamNotRecorded')
  }

  return value
}

// 移除内部命名空间，只把用户可读的维度值展示在图上。
function formatNodeName(name: string) {
  const node = parseNodeName(name)
  return formatDimensionValue(node.column, node.value)
}

// 根据当前勾选状态决定是否禁止取消列，确保图表至少保留两个维度。
function isColumnDisabled(column: TrafficSankeyColumn) {
  return selectedColumns.value.length <= 2 && selectedColumnSet.value.has(column)
}

// 判断这一行是否真实触达上游；只有 direct_upstream 会连接到 upstream 列。
function shouldIncludeUpstream(row: TrafficSankeyRow) {
  return row.outcome === 'direct_upstream' && row.upstream !== 'not_recorded'
}

// 按当前可见列生成一行的路径，非 direct_upstream 的路径会停在 upstream 前。
function createRowPath(
  row: TrafficSankeyRow,
  columns: readonly TrafficSankeyColumn[],
) {
  const path: SankeyPathNode[] = []

  for (const column of columns) {
    if (column === 'upstream' && !shouldIncludeUpstream(row)) {
      continue
    }

    path.push({
      column,
      name: createNodeName(column, row[column]),
    })
  }

  return path
}

// 将后端 rows 按当前可见列聚合成 ECharts Sankey 的节点和连线。
function aggregateSankeyRows(
  rows: readonly TrafficSankeyRow[],
  columns: readonly TrafficSankeyColumn[],
): SankeyBuildResult {
  const linksByKey = new Map<string, SankeyLink>()
  const nodeValues = new Map<string, number>()
  const nodeDepths = new Map<string, number>()
  const columnDepths = new Map(
    columns.map((column, index) => [column, index]),
  )

  for (const row of rows) {
    if (row.value <= 0) {
      continue
    }

    const path = createRowPath(row, columns)
    for (const node of path) {
      nodeDepths.set(node.name, columnDepths.get(node.column) ?? 0)
      nodeValues.set(node.name, (nodeValues.get(node.name) ?? 0) + row.value)
    }

    for (let index = 0; index < path.length - 1; index += 1) {
      const source = path[index].name
      const target = path[index + 1].name
      const key = `${source}\u0000${target}`
      const existing = linksByKey.get(key)
      if (existing) {
        existing.value += row.value
      } else {
        linksByKey.set(key, {
          source,
          target,
          value: row.value,
        })
      }
    }
  }

  return {
    links: Array.from(linksByKey.values()),
    nodeValues,
    nodeDepths,
  }
}

// 统计节点最多的深度，让画布高度始终能容纳最拥挤的一列标签。
function getMaximumNodeCountByDepth(nodeDepths: ReadonlyMap<string, number>) {
  const nodeCountsByDepth = new Map<number, number>()

  for (const depth of nodeDepths.values()) {
    nodeCountsByDepth.set(depth, (nodeCountsByDepth.get(depth) ?? 0) + 1)
  }

  return Math.max(0, ...nodeCountsByDepth.values())
}

// 格式化请求数，尽量保留 Analytics Engine 聚合后的整数阅读体验。
function formatRequestCount(value: number) {
  return Math.round(value).toLocaleString()
}

// 为节点和连线生成可读 tooltip，连线显示 source -> target 和请求数。
function formatTooltip(params: SankeyTooltipParams) {
  const data = params.data ?? {}

  if (data.source && data.target) {
    return `${formatNodeName(data.source)} -> ${formatNodeName(data.target)}<br/>${requestCountLabel.value}: ${formatRequestCount(data.value ?? 0)}`
  }

  const name = data.name ?? params.name ?? ''
  const value = data.value ?? params.value ?? 0
  return `${formatNodeName(name)}<br/>${requestCountLabel.value}: ${formatRequestCount(value)}`
}

const chartData = computed(() =>
  aggregateSankeyRows(props.rows, visibleColumns.value),
)

// 按节点最多的一列动态增高画布，为每个 12px 标签保留稳定的垂直阅读空间。
const chartHeight = computed(() =>
  Math.max(
    sankeyMinimumChartHeight,
    getMaximumNodeCountByDepth(chartData.value.nodeDepths) *
      sankeyNodeSlotHeight +
      sankeyVerticalPadding,
  ),
)

// 把计算结果作为内联高度交给 VChart，维度切换后 autoresize 会同步重排图表。
const chartStyle = computed(() => ({
  height: `${chartHeight.value}px`,
}))

const chartOption = computed(() => {
  const lastVisibleDepth = Math.max(0, visibleColumns.value.length - 1)

  return {
    animationDuration: 400,
    color: sankeyColorPalette,
    tooltip: {
      trigger: 'item',
      formatter: formatTooltip,
    },
    series: [
      {
        type: 'sankey',
        data: Array.from(chartData.value.nodeValues, ([name, value]) => ({
          name,
          value,
          depth: chartData.value.nodeDepths.get(name),
          // 只有最后一列靠近右边缘，标签放到节点左侧才能稳定留在画布内部。
          label:
            chartData.value.nodeDepths.get(name) === lastVisibleDepth
              ? { position: 'left' }
              : undefined,
        })),
        links: chartData.value.links,
        draggable: false,
        nodeAlign: 'justify',
        nodeGap: sankeyNodeGap,
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
  <div class="traffic-sankey">
    <div
      class="traffic-sankey-controls"
      role="group"
      :aria-label="controlsAriaLabel"
    >
      <span class="traffic-sankey-controls-label">
        {{ t('trafficSankey.columnsLabel') }}
      </span>
      <el-checkbox-group
        v-model="selectedColumns"
        class="traffic-sankey-checkboxes"
        :aria-label="controlsAriaLabel"
      >
        <el-checkbox
          v-for="option in columnOptions"
          :key="option.value"
          :disabled="isColumnDisabled(option.value)"
          :value="option.value"
        >
          {{ option.label }}
        </el-checkbox>
      </el-checkbox-group>
    </div>
    <VChart
      :key="chartLocaleKey"
      class="traffic-sankey-chart"
      :aria-label="chartAriaLabel"
      :option="chartOption"
      :style="chartStyle"
      autoresize
      role="img"
    />
  </div>
</template>
