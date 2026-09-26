# Metrics 查询

入口请求统计写入 Workers Analytics Engine 数据集 `rsshub_balancer_request_flows`，只保存来源国家/地区和最终上游。Worker 直接写 binding，Node 将 `{ events: [...] }` 批量上传到 Worker 的 `POST /_internal/metrics/ingest`；每个事件只含 `country`、`upstream`。ingest 依赖 Cloudflare WAF 将访问限制为服务器出口 IP，不使用应用层 token。

Worker binding `METRICS` 与查询表名均指向 `rsshub_balancer_request_flows`；写入、查询和首页使用同一字段格式。平台会在首次写入时自动创建数据集，见[官方说明](https://developers.cloudflare.com/analytics/analytics-engine/get-started/#1-name-your-dataset-and-add-it-to-your-worker)。

## 记录范围与字段

进入完整选路、到达现有记录位置的 GET/HEAD 请求每次写入一个数据点，只记录最终结果。Cache HIT 和入口拒绝不计入。完整选路内部的 fallback 和重试继续记录最终结果。

| 字段 | 含义 | 当前值 |
| --- | --- | --- |
| `blob1` | `country` | 原始请求来源国家/地区，缺失或为空时为 `unknown` |
| `blob2` | `upstream` | 最终尝试的上游 URL，未触达任何上游时为 `none` |

写入内容仅为 `{ blobs: [country, upstream] }`，不传 `indexes`、`doubles` 或占位字段。`country` 在 Worker 优先读取 `request.cf.country`，缺失时读取 `CF-IPCountry`；Node 读取可信代理传入的 `CF-IPCountry`。ingest 沿用事件中的国家，不用上传请求的地域覆盖它。

`upstream` 只代表这次请求最终尝试的实例，不展开重试过程，也不表示该上游一定成功。所有候选已标记失败等未发起上游请求的情况写入 `none`，首页显示“未触达上游”。

## 最近 24 小时国家到上游的请求数量

`GET /_internal/metrics/country-colo-sankey` 随 RSS 承接环境由 Node 或 Worker 提供，两端通过同一 HTTP SQL API 查询。服务端配置 `CLOUDFLARE_ACCOUNT_ID` 和具备 Account Analytics Read 权限的 `CLOUDFLARE_ANALYTICS_API_TOKEN`，不接受客户端自定义 SQL。

```sql
SELECT
  blob1 AS country,
  blob2 AS upstream,
  sum(_sample_interval) AS request_total
FROM rsshub_balancer_request_flows
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY country, upstream
ORDER BY request_total DESC
FORMAT JSON
```

接口返回 `{ rows, generatedAt, windowHours: 24 }`，每行为 `{ country, upstream, value }`。SQL API 的整数聚合结果 `request_total` 是字符串，服务端用 `Number(row.request_total)` 转为数字后作为 `value` 返回。

首页默认展示 `country -> upstream`，连线宽度、节点总量和悬浮提示均使用这个请求数量。维度复选框和按可见列绘图的逻辑继续保留，当前提供国家和上游两个选项，可自由勾选或取消，不限制最少显示列数；后续新增维度时继续使用同一选择逻辑。

每个数据点代表一次被记录的请求，按平台 `_sample_interval` 求和即可修正采样，无需额外写入固定为 `1` 的计数字段，见 [Analytics Engine 采样说明](https://developers.cloudflare.com/analytics/analytics-engine/sampling/#how-to-read-sampled-data)。最近 24 小时使用平台写入时间 `timestamp`，包含 Node 排队和上传延迟。指标是近似统计，允许丢失，不作为计费、审计或故障切换依据；Node 退出时不额外上传内存队列。

## 首页图表加载

首页挂载后并行请求实例列表和流量统计；统计成功且 `rows` 非空时，才通过 Vue `defineAsyncComponent()` 动态加载桑基图。ECharts、图表复选框及其组件样式由 Vite 自动分包，不在首页启动时预加载，手写 vendor 分包规则已移除。此加载时机优先保证正文、语言按钮和接口请求先启动，并省去空统计或接口失败时的图表下载；正常显示图表仍需下载全部相关代码。

统计请求期间保留原来的数据加载提示，随后图表代码下载期间显示独立加载提示。图表 JS 或 CSS 加载失败时提示刷新重试，正文与语言按钮继续可用，提示同步切换中英文；统计为空、接口失败或响应格式不符时沿用原有状态，不加载图表。

### 2026-09-26 本地验证

生产构建的启动 JavaScript gzip 合计从 248.28 KB 降到 83.96 KB；新的图表异步包为 166.10 KB。HTML 不再包含图表 `modulepreload`，构建 manifest 仅通过 `dynamicImports` 引用图表，浏览器也确认在统计响应完成后才请求图表 JS/CSS。正常显示图表时的总 JavaScript gzip 约 250.06 KB，收益主要来自启动依赖减少。

使用本地 Chrome 146 测量修改前后的生产产物：静态资源启用 gzip 和长期缓存，模拟 80 ms 网络延迟、200 KiB/s 下载、4 倍 CPU 降速，统计接口固定延迟 200 ms 并返回两行模拟数据。每个版本执行三组独立浏览器上下文内的首次访问与再次访问，下表为相对导航开始的中位数，单位 ms。再次访问确认所有静态资源命中浏览器缓存，没有通过请求拦截伪造缓存。

| 版本与缓存状态 | 正文首次绘制（FCP） | 统计请求发起 | 图表首次绘制 |
| --- | ---: | ---: | ---: |
| 修改前，首次访问 | 1644 | 1550 | 1922 |
| 异步加载，首次访问 | 800 | 699 | 2021 |
| 修改前，缓存命中 | 192 | 147 | 443 |
| 异步加载，缓存命中 | 164 | 134 | 454 |

图表首次绘制通过检测画布出现非透明像素后的下一动画帧记录，不代表动画全部结束。结果支持优先正文与接口请求、统计非空后再加载图表的取舍；本次模拟冷加载中图表晚约 99 ms，缓存命中时差异较小。这些数据来自本地固定条件，不代表线上实测或所有设备的改善幅度。

浏览器验证覆盖慢统计请求、慢图表下载、图表 JS/CSS 各自加载失败、空统计、接口 503、响应格式错误，以及等待和失败期间的中英文切换、加载后的维度切换。空统计和接口错误场景均未请求图表资源。`pnpm typecheck`、`pnpm lint`、`pnpm build` 与 `git diff --check` 均通过。
