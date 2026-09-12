# Metrics 查询

入口请求统计写入 Workers Analytics Engine 数据集 `rsshub_balancer_metrics`。指标是近似统计，查询时需要使用 `_sample_interval` 修正采样。

未来 Node/Hono 云下部署将继续把 Analytics Engine 作为首页桑基图的唯一数据源，由 Node 批量经过固定在 Worker 的受保护 `POST /_internal/metrics/ingest` 写入；该方向尚未实施，见 [云下桑基图数据回传 Analytics Engine 方案](./worker-migration/sankey-analytics-engine-ingestion-plan.md)。

迁移设计保留 `GET /_internal/metrics/country-colo-sankey`，查询接口随 RSS 承接环境切换，正常和恢复后由 Node、接管时由 Worker 通过同一 HTTP SQL API 读取该数据集；两端分别注入服务端 account/token 查询配置。

桑基图已决定简化为 `country -> outcome -> upstream`。接口保留 `{ rows, generatedAt, windowHours }` 外壳，`rows` 中删除 `edgeColo`，保留 `country`、`outcome`、`upstream` 和 `value`；指标写入、查询及前端同步调整，均尚未实施。其它可视化维度见 [丰富桑基图字段](./todo.md#丰富桑基图字段)。

## 字段与 label

当前只保留 `route_request` 作为主指标：未命中 `DIRECT_FALLBACK_RATE`、进入完整选路处理的 `GET` / `HEAD` 请求在现有记录位置写入一条数据点。前置直转 fallback 分支仍然漏记，完整选路内部的 fallback 和重试继续记录最终结果；漏记修复已移入 [TODO](./todo.md#前置-fallback-请求的桑基图漏记)，不随本次云上云下迁移处理。公开代理入口被边缘拒绝的方法不会进入上游转发，也不会写入 `route_request`。所有数据点都写入同一个全局索引，`index1` 固定为 `global`；用 `double1` 记录事件计数，固定写入 `1`；用 `double2` 记录这次入口请求耗时，单位是毫秒。

| 字段 | label | 当前取值 | 说明 |
| --- | --- | --- | --- |
| `blob1` | `metric` | `route_request` | 指标名称 |
| `blob2` | `layer` | `edge` | 入口请求层级，固定为 `edge` |
| `blob3` | `role` | `none` | 保留旧字段位置，当前固定为 `none` |
| `blob4` | `method` | 实际 HTTP method，例如 `GET` / `HEAD` | 入口请求方法 |
| `blob5` | `outcome` | `direct_upstream` / `isolate_coalesced` / `do_coalesced` | 请求最终处理方式 |
| `blob6` | `status` | 响应状态码字符串，例如 `200` / `404` / `503` | 最终返回或被复用响应的 HTTP 状态码 |
| `blob7` | `upstream` | 实际 upstream URL / `none` | 仅 `direct_upstream` 记录最终触达的 upstream；其它 outcome 为 `none` |
| `blob8` | `country` | 国家/地区代码 / `unknown` | Cloudflare `request.cf.country`；无法判断时为 `unknown` |
| `blob9` | `edge_colo`（待停写） | Cloudflare 机房代码 / `unknown` | 当前来自 `request.cf.colo`；迁移后保留字段位置，新数据写空字符串 |
| `double1` | `count` | `1` | 事件计数，查询时用 `sum(_sample_interval * double1)` 统计近似次数 |
| `double2` | `duration_ms` | 毫秒数 | 入口请求整体耗时 |

当前 `route_request` 的 `blob8` 直接来自 Cloudflare metadata 的 `request.cf.country`，只记录国家/地区代码，不记录更细的 region。值通常是 ISO 3166-1 alpha-2，例如 `US`、`JP`；Tor 可能为 `T1`；缺失或无法判断时为 `unknown`。`blob9` 当前仍记录 `request.cf.colo`，缺失时为 `unknown`。

迁移后，`blob9` 写入 `''` 占位，其它字段索引不移动。新查询忽略历史数据的机房值，按 `country`、`outcome` 和 `upstream` 跨机房聚合，保留原有采样修正计数。

按处理方式拆开看，`blob5` 目前会出现这些取值：

| `outcome` | `upstream` | 记录时机 |
| --- | --- | --- |
| `direct_upstream` | 实际 upstream URL | 这次 GET/HEAD 入口请求真实打到了上游，包括 DO 抽样未命中、DO RPC 失败降级、DO leader |
| `isolate_coalesced` | `none` | GET/HEAD 在当前 Worker isolate 内成为 follower，复用了同 isolate 的进行中结果 |
| `do_coalesced` | `none` | GET/HEAD 进入 Durable Object 后成为 follower，复用了 DO 内的进行中结果 |

## 最近 24 小时请求处理方式分布

这个 SQL 按 `route_request.blob5` 聚合最近 24 小时的请求处理方式，适合直接给饼图、环图或趋势面板使用。刚上线后最近 24 小时窗口可能混入旧版本数据，因此只统计三个新 outcome。

```sql
SELECT
  blob5 AS outcome,
  sum(_sample_interval * double1) AS request_total
FROM rsshub_balancer_metrics
WHERE timestamp > NOW() - INTERVAL '1' DAY
  AND blob1 = 'route_request'
  AND blob5 IN (
    'direct_upstream',
    'isolate_coalesced',
    'do_coalesced'
  )
GROUP BY outcome
ORDER BY request_total DESC
```

## 最近 24 小时请求 Method 分布

进入代理/路由处理的 `GET` / `HEAD` 入口请求会用 `route_request` 指标记录 method，存在 `blob4`。公开代理入口被边缘拒绝的方法不再计入这里的 method 分布。这个 SQL 用来查看当前时间窗口内进入代理处理过哪些 HTTP methods，以及每种 method 的近似请求数。

```sql
SELECT
  blob4 AS method,
  sum(_sample_interval * double1) AS request_total
FROM rsshub_balancer_metrics
WHERE timestamp > NOW() - INTERVAL '1' DAY
  AND blob1 = 'route_request'
GROUP BY blob4
ORDER BY request_total DESC
```

## 最近 24 小时请求国家/地区分布

入口代理请求会用 `route_request` 指标记录来源国家/地区，country 存在 `blob8`。上线前旧数据没有有效 `blob8`，会和空字符串一起归入 `unknown`。

```sql
SELECT
  if(blob8 = '', 'unknown', blob8) AS country,
  sum(_sample_interval * double1) AS request_total
FROM rsshub_balancer_metrics
WHERE timestamp > NOW() - INTERVAL '1' DAY
  AND blob1 = 'route_request'
GROUP BY country
ORDER BY request_total DESC
```

## 最近 24 小时请求来源到处理方式到 upstream 分布（待实施方案）

以下 SQL 用于移除机房后的三层桑基图：`country -> outcome -> upstream`，权重为 `request_total`。它沿用首页查询现有的 `direct_upstream` 筛选，只按国家、处理方式和最终触达上游聚合；旧数据中的不同 `blob9` 值合并计数。该 SQL 尚未替换代码中的查询。

```sql
SELECT
  blob8 AS country,
  blob5 AS outcome,
  if(
    blob5 = 'direct_upstream' AND blob7 != '' AND blob7 != 'none',
    blob7,
    'not_recorded'
  ) AS upstream,
  sum(_sample_interval * double1) AS request_total
FROM rsshub_balancer_metrics
WHERE timestamp > NOW() - INTERVAL '1' DAY
  AND blob1 = 'route_request'
  AND blob5 = 'direct_upstream'
GROUP BY country, outcome, upstream
ORDER BY request_total DESC
FORMAT JSON
```

## 最近 24 小时 upstream 请求数量

真实打到上游的入口请求会用 `route_request` 的 `direct_upstream` outcome 记录，最终触达的 upstream 存在 `blob7`。这个 SQL 用来查看各 upstream 在实际请求中的近似请求数。

注意：`blob7` 表示这次入口请求最终触达的 upstream，不是每次 retry attempt 的展开记录。如果一次入口请求先后尝试多个 upstream，当前统计只会把这次请求计入最终触达的那个 upstream；它适合观察最终承接流量占比，不适合观察真实出站 attempt 分布。

```sql
SELECT
  blob7 AS upstream,
  sum(_sample_interval * double1) AS direct_total
FROM rsshub_balancer_metrics
WHERE timestamp > NOW() - INTERVAL '1' DAY
  AND blob1 = 'route_request'
  AND blob5 = 'direct_upstream'
  AND blob7 != 'none'
GROUP BY blob7
ORDER BY direct_total DESC
```
