# Metrics 查询

入口请求统计写入 Workers Analytics Engine 数据集 `rsshub_balancer_metrics`。指标是近似统计，查询时需要使用 `_sample_interval` 修正采样。最近 24 小时按服务端 ingest 时间统计，包含 Node 排队和上传延迟，不能作为计费、审计或故障切换依据。Node 退出时不额外上传内存队列，未上传指标允许丢失。

Node/Hono 继续把 Analytics Engine 作为首页桑基图的唯一数据源，由 Node 批量经过固定在 Worker 的受保护 `POST /_internal/metrics/ingest` 写入，Worker 承接请求时直接写 binding。云上新版已部署、验证通过并完成 review；Node 回传已完成本地实现，当前待 review、部署及端到端验收，见 [云下桑基图数据回传 Analytics Engine 方案](./worker-migration/sankey-analytics-engine-ingestion-plan.md)。

保留 `GET /_internal/metrics/country-colo-sankey`，查询接口随 RSS 承接环境切换，正常和恢复后由 Node、接管时由 Worker 通过同一 HTTP SQL API 读取该数据集；两端从服务端环境变量读取 account/token 查询配置。

桑基图已简化为 `country -> outcome -> upstream`。接口保留 `{ rows, generatedAt, windowHours }` 外壳，`rows` 中删除 `edgeColo`，保留 `country`、`outcome`、`upstream` 和 `value`；指标写入、查询及前端已同步调整，线上进度见[实施状态](./worker-migration/implementation-status.md)。其它可视化维度见 [丰富桑基图字段](./todo.md#丰富桑基图字段)。

## 字段与 label

当前只保留 `route_request` 作为主指标：未命中 `DIRECT_FALLBACK_RATE`、进入完整选路处理的 `GET` / `HEAD` 请求在现有记录位置写入一条数据点。前置直转 fallback 分支仍然漏记，完整选路内部的 fallback 和重试继续记录最终结果；漏记修复已移入 [TODO](./todo.md#前置-fallback-请求的桑基图漏记)，不随本次云上云下迁移处理。公开代理入口被边缘拒绝的方法不会进入上游转发，也不会写入 `route_request`。所有数据点都写入同一个全局索引，`index1` 固定为 `global`；用 `double1` 记录事件计数，固定写入 `1`；用 `double2` 记录这次入口请求耗时，单位是毫秒。

| 字段 | label | 当前取值 | 说明 |
| --- | --- | --- | --- |
| `blob1` | `metric` | `route_request` | 指标名称 |
| `blob2` | `layer` | Node `origin`；Worker `edge` | 保留原字段位置 |
| `blob3` | `role` | `none` | 保留旧字段位置，当前固定为 `none` |
| `blob4` | `method` | `GET` / `HEAD` | 入口请求方法 |
| `blob5` | `outcome` | `direct_upstream` | 请求最终处理方式；旧数据可能包含合并结果 |
| `blob6` | `status` | 响应状态码字符串，例如 `200` / `404` / `503` | 最终响应的 HTTP 状态码 |
| `blob7` | `upstream` | 实际 upstream URL / `none` | 仅 `direct_upstream` 记录最终触达的 upstream；其它 outcome 为 `none` |
| `blob8` | `country` | 原始请求的国家/地区值 / `unknown` | 缺失或空值为 `unknown`，不检查代码格式 |
| `blob9` | 原 `edge_colo` 位置 | 空字符串 | 保留字段位置，查询忽略历史机房值 |
| `blob10` | `plane` | Node `origin`；Worker `worker_failover` | 由写入端固定设置 |
| `blob11` | `schema_version` | `2` | 当前指标版本 |
| `double1` | `count` | `1` | 事件计数，查询时用 `sum(_sample_interval * double1)` 统计近似次数 |
| `double2` | `duration_ms` | 毫秒数 | 入口请求整体耗时 |

当前 `route_request` 的 `blob8` 来自原始 RSS 请求：Worker 优先使用 Cloudflare metadata 的 `request.cf.country`，未提供时读取 `CF-IPCountry`；Node 直接读取 `CF-IPCountry`。直接记录来源值，不检查代码格式，不记录更细的 region；缺失或空值为 `unknown`。ingest 不用上传请求的地域覆盖 payload；部署层须限制来源。

本服务生成固定格式的指标，Worker 本地记录与 ingest 直接按上述字段映射写入，不做指标字段或版本的运行时校验。v2 的 `blob9` 写入 `''` 占位，其它字段索引不移动。新查询忽略历史数据的机房值，按 `country`、`outcome` 和 `upstream` 跨机房聚合，保留原有采样修正计数。

当前代码只生成 `direct_upstream`；历史数据不改写，查询仍可看到以下处理方式。历史空 `blob10` 在按 plane 查询时归为 `legacy_worker`。

| `outcome` | `upstream` | 记录时机 |
| --- | --- | --- |
| `direct_upstream` | 实际 upstream URL | 这次 GET/HEAD 入口请求真实打到了上游，记录完整选路的最终结果 |
| `isolate_coalesced` | `none` | 历史 GET/HEAD 在 Worker isolate 内复用进行中结果 |
| `do_coalesced` | `none` | 历史 GET/HEAD 通过 Durable Object 复用进行中结果 |

## 最近 24 小时请求处理方式分布

这个 SQL 按 `route_request.blob5` 聚合最近 24 小时的请求处理方式，适合直接给饼图、环图或趋势面板使用。最近 24 小时窗口可能含旧版本数据，因此查询保留这三个 outcome。

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

## 最近 24 小时请求来源到处理方式到 upstream 分布

以下 SQL 已用于三层桑基图：`country -> outcome -> upstream`，权重为 `request_total`。它沿用首页查询现有的 `direct_upstream` 筛选，只按国家、处理方式和最终触达上游聚合；旧数据中的不同 `blob9` 值合并计数。接口保留原有 URL，不接受客户端自定义 SQL。

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
