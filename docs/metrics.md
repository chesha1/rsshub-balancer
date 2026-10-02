# Metrics 查询

入口请求统计写入 Workers Analytics Engine 数据集 `rsshub_balancer_request_results`，只保存来源国家/地区、请求一级路径和请求最终结果。结果沿用 `upstream` 字段：成功时为对应上游 URL，失败时为 `failed`。Worker 直接写 binding，Node 将 `{ events: [...] }` 批量上传到 Worker 的 `POST /_internal/metrics/ingest`；每个事件只含 `country`、`upstream`、`path`。ingest 依赖 Cloudflare WAF 将访问限制为服务器出口 IP，不使用应用层 token。

Worker binding `METRICS` 与查询表名均指向 `rsshub_balancer_request_results`；写入、查询和首页使用同一字段格式。平台会在首次写入时自动创建数据集，见[官方说明](https://developers.cloudflare.com/analytics/analytics-engine/get-started/#1-name-your-dataset-and-add-it-to-your-worker)。

## 记录范围与字段

共享 RSS 代理入口仅对通过方法检查的 GET/HEAD 请求采集指标，不包含首页、本站资源、健康检查、内部接口和入口拒绝；Cloudflare Cache HIT 未进入应用，也不计入。

本站资源指 `/_assets` 目录（`/_assets`、`/_assets/` 及其所有子路径）和根目录静态文件（根目录下只有一个路径段、扩展名为图片、图标、样式、脚本或字体的地址，如 `/favicon.ico`、`/apple-touch-icon.png`），规则见 [utils.ts](../packages/server-core/src/utils.ts) 中的 `isLocalResourcePath()`。共享路由在进入代理前只按请求路径判断，命中后直接返回 404，不触发上游探测、转发、失败标记或指标写入，因此 ingest、SQL 查询和首页无需另行过滤静态资源路径。范围之外的未知路径仍会进入代理并照常统计，被 Cloudflare WAF 拦截的扫描请求除外。

采集分为两个时点，但每个请求只写入一个数据点：

1. 进入 RSS 代理、开始选路前，从原始请求保存 `country`，并提取第一级路径作为 `path`。它们属于当前请求的局部数据，不放入模块级状态，也不从上游响应反推。
2. 选路结束后补上成功返回响应的上游 URL，或统一的失败值 `failed`，一次性记录完整事件。重试和 fallback 不额外计数；失败缓存拦截、本次尝试全部失败和内部异常均属于请求失败，仍保留入口一级路径。

平台适配只负责传输和写入已经采集好的事件：Node 的有界队列不重读请求，Worker 的 ingest 不用上传请求覆盖事件。请求最终结果在入口尚未确定，因此写入仍在选路结束后发生；处理中进程退出的请求不保证被统计。

| 字段 | 含义 | 当前值 |
| --- | --- | --- |
| `blob1` | `country` | 原始请求来源国家/地区，缺失或为空时为 `unknown` |
| `blob2` | `upstream` | 成功返回响应的上游 URL；请求最终失败时统一为 `failed` |
| `blob3` | `path` | 原始请求 URL 的 `pathname` 第一级，例如 `/github`；必有值，不含后续路径段或查询字符串 |

写入内容仅为 `{ blobs: [country, upstream, path] }`，不传 `indexes`、`doubles` 或占位字段；路径追加为第三列，保留已有两列的含义，符合 [Analytics Engine 按数组顺序映射字段的约定](https://developers.cloudflare.com/analytics/analytics-engine/get-started/#2-write-data-points-from-your-worker)。`country` 在 Worker 优先读取 `request.cf.country`，缺失时读取 `CF-IPCountry`；Node 读取可信代理传入的 `CF-IPCountry`。ingest 沿用事件中的国家，不用上传请求的地域覆盖它。

`path` 从 `new URL(request.url).pathname` 提取第一级，并保留开头的 `/`，例如 `/github/repos/DIYgod/RSSHub/releases` 只记录为 `/github`，`/bilibili/user/video/12345` 只记录为 `/bilibili`。同一一级路径下的后续路径段、用户 ID、其他路径参数和查询字符串均不记录，并合并计数。它无需上游响应、路由映射或 `unknown` 占位，也不读取 `X-RSSHub-Route`。一级路径会在公开桑基图中展示，也包含无法识别的请求，不代表有效订阅数量。不额外采集 HTTP 状态码、耗时、ASN、城市、内容类别或客户端分类等字段。

`upstream` 的成功判定沿用现有选路逻辑：上游响应状态为 200–399 时记录该实例；这包含重定向和 304，不保证重定向最终成功或响应正文完整送达客户端。先尝试 A 失败、再尝试 B 成功时只记录 B；所有实际尝试均失败、全部候选被失败标记跳过，或处理过程出现内部异常时，统一记录 `failed`。首页将其显示为“请求失败”，不再把失败请求归到最后尝试的实例。具体尝试过哪些上游以及缓存失败、转发失败等原因继续保留在日志中。

## 新口径与发布顺序

旧数据集 `rsshub_balancer_request_flows` 的上游 URL 混合了成功请求和最后一次失败尝试，无法可靠还原请求结果。新口径独立写入 `rsshub_balancer_request_results`，不查询或回填旧数据；旧数据集不删除。事件协议和查询响应都要求完整的 `country`、`path`、`upstream` 三字段，不添加版本或其他采集字段。

发布时先更新 Origin，确认旧进程已停止，再紧接着更新 Edge（包含 Web），让新数据集只接收新口径事件。如果先更新 Edge，旧 Origin 上传的最后尝试实例会被误当作成功结果写入新数据集。两步之间以及新数据集首次写入前，统计查询可能暂时不可用；写入并可查询后开始展示，满 24 小时后覆盖完整时间窗口。

## 最近 24 小时国家、一级路径与处理结果的请求数量

`GET /_internal/metrics/country-colo-sankey` 随 RSS 承接环境由 Node 或 Worker 提供，两端通过同一 HTTP SQL API 查询。服务端配置 `CLOUDFLARE_ACCOUNT_ID` 和具备 Account Analytics Read 权限的 `CLOUDFLARE_ANALYTICS_API_TOKEN`，不接受客户端自定义 SQL。

```sql
SELECT
  blob1 AS country,
  blob2 AS upstream,
  blob3 AS path,
  sum(_sample_interval) AS request_total
FROM rsshub_balancer_request_results
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY country, upstream, path
ORDER BY request_total DESC
FORMAT JSON
```

接口返回 `{ rows, generatedAt, windowHours: 24 }`，每行为 `{ country, upstream, path, value }`。SQL API 的整数聚合结果 `request_total` 是字符串，服务端用 `Number(row.request_total)` 转为数字后作为 `value` 返回。

首页默认展示 `country -> path -> upstream`，最后一列标为“处理结果”，包含成功上游和统一的“请求失败”节点。国家/地区和一级路径分别按完整数据的请求量保留前 30 项，其余合并为“其他地区”或“其他路径”；处理结果不合并，所有请求仍参与计数。连线宽度、节点总量和悬浮提示均使用请求数量。维度复选框提供国家、请求一级路径和处理结果三个选项，可自由勾选或取消，不限制最少显示列数；取消路径时按可见列重新聚合为 `country -> upstream`，这批数据的请求总量不变。成功上游可点击打开，失败节点不提供链接。

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

### 桑基图绘制性能

当前桑基图通过 Top30＋其他分组减少节点、连线及画布高度，保留 Canvas、曲率 `0.5`、渐变、悬浮提示、邻接高亮及上游点击。系列内 `animationDuration: 0` 继续取消首次展开。后续 WebGL / GPU 绘制方案记录在 [TODO](todo.md)；上面的异步加载优化只影响首页启动时机。
