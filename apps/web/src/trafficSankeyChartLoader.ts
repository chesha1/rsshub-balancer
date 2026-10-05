import { defineAsyncComponent } from 'vue'
import ChartError from './ChartError.vue'
import ChartLoading from './ChartLoading.vue'

let trafficSankeyChartModule:
  | Promise<typeof import('./TrafficSankeyChart.vue')>
  | undefined

// 图表包只发起一次 import()，提前下载和异步组件渲染共用同一个 Promise。
// Vite 的预加载只在首次 import() 时等待并检查图表 CSS；共用 Promise 才能让渲染等到样式就绪，CSS 加载失败时也显示错误提示。
function loadTrafficSankeyChartModule() {
  trafficSankeyChartModule ??= import('./TrafficSankeyChart.vue')
  return trafficSankeyChartModule
}

// 提前下载图表包，开始时机由页面决定；加载失败交给异步组件的 errorComponent 提示，这里只避免未处理的 rejection。
export async function preloadTrafficSankeyChart() {
  try {
    await loadTrafficSankeyChartModule()
  } catch {}
}

// 图表包不进入首页入口；渲染时仍在下载则显示 ChartLoading，JS 或 CSS 加载失败时显示 ChartError。
export const TrafficSankeyChart = defineAsyncComponent({
  loader: loadTrafficSankeyChartModule,
  loadingComponent: ChartLoading,
  errorComponent: ChartError,
  delay: 0,
})
