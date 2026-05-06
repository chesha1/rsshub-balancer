# Metrics 查询

合并收益统计写入 Workers Analytics Engine 数据集 `rsshub_balancer_metrics`。指标是近似统计，查询时需要使用 `_sample_interval` 修正采样。

## 字段与 label

当前所有指标都写入同一个全局索引，`index1` 固定为 `global`。每条数据点用 `double1` 记录事件计数，固定写入 `1`；用 `double2` 记录这次请求或合并流程耗时，单位是毫秒。

| 字段 | label | 当前取值 | 说明 |
| --- | --- | --- | --- |
| `blob1` | `metric` | `route_request` / `coalesce_role` / `direct_upstream` / `benefited` | 指标名称 |
| `blob2` | `layer` | `edge` / `isolate` / `do` | 指标发生的层级 |
| `blob3` | `role` | `leader` / `follower` / `none` | 请求在合并流程中的角色；不适用时为 `none` |
| `blob4` | `method` | 实际 HTTP method，例如 `GET` / `HEAD` / `POST` | 入口请求方法 |
| `blob5` | `reason` | `non_get` / `do_leader` / `do_rpc_failed` / `isolate_follower` / `do_follower` / `none` | 记录这条指标的原因；不适用时为 `none` |
| `blob6` | `status` | 响应状态码字符串，例如 `200` / `404` / `503` | 最终返回或被复用响应的 HTTP 状态码 |
| `blob7` | `upstream` | 实际 upstream URL / `none` | `direct_upstream` 会记录 leader 最终触达的 upstream；其它指标默认 `none` |
| `double1` | `count` | `1` | 事件计数，查询时用 `sum(_sample_interval * double1)` 统计近似次数 |
| `double2` | `duration_ms` | 毫秒数 | 请求、合并或上游转发耗时 |

按指标拆开看，目前会出现这些 label 组合：

| `metric` | `layer` | `role` | `reason` | `upstream` | 记录时机 |
| --- | --- | --- | --- | --- | --- |
| `route_request` | `edge` | `none` | `none` | `none` | 通用转发入口收到并完成一次请求 |
| `coalesce_role` | `isolate` | `leader` | `none` | `none` | GET/HEAD 在当前 isolate 内成为 leader |
| `coalesce_role` | `isolate` | `follower` | `isolate_follower` | `none` | GET/HEAD 在当前 isolate 内复用已有请求 |
| `coalesce_role` | `do` | `leader` | `none` | `none` | 请求进入 Durable Object 后成为 leader |
| `coalesce_role` | `do` | `follower` | `do_follower` | `none` | 请求进入 Durable Object 后复用已有请求 |
| `direct_upstream` | `edge` | `none` | `non_get` | 实际 upstream URL | 非 GET/HEAD 请求直接转发上游 |
| `direct_upstream` | `isolate` | `leader` | `do_rpc_failed` | 实际 upstream URL | Durable Object RPC 失败后在 isolate 降级直连上游 |
| `direct_upstream` | `do` | `leader` | `do_leader` | 实际 upstream URL | Durable Object leader 真实请求上游 |
| `benefited` | `isolate` | `follower` | `isolate_follower` | `none` | isolate follower 复用结果，节省一次上游请求 |
| `benefited` | `do` | `follower` | `do_follower` | `none` | Durable Object follower 复用结果，节省一次上游请求 |

## 最近 24 小时合并收益

这个 SQL 统计最近 24 小时的合并收益，适合直接给饼图或环图使用。

- `direct_total`：真实打到上游的请求数，包括 DO leader、非 GET/HEAD 直连、DO RPC 失败后的降级直连
- `isolate_benefited_total`：在同一个 Worker isolate 内复用已有请求结果的 follower 数
- `do_benefited_total`：跨 isolate 进入 Durable Object 后复用已有请求结果的 follower 数
- `benefited_total`：两层合并一共节省的请求数
- `total`：`direct_total + benefited_total`，也就是参与这张图统计的总请求数
- `*_percent`：各分类在 `total` 中的占比，保留两位小数

```sql
SELECT
  direct_total,
  isolate_benefited_total,
  do_benefited_total,
  isolate_benefited_total + do_benefited_total AS benefited_total,
  direct_total + isolate_benefited_total + do_benefited_total AS total,
  if(
    direct_total + isolate_benefited_total + do_benefited_total = 0,
    0.0,
    round(
      direct_total * 100 / (
        direct_total + isolate_benefited_total + do_benefited_total
      ),
      2
    )
  ) AS direct_percent,
  if(
    direct_total + isolate_benefited_total + do_benefited_total = 0,
    0.0,
    round(
      isolate_benefited_total * 100 / (
        direct_total + isolate_benefited_total + do_benefited_total
      ),
      2
    )
  ) AS isolate_benefited_percent,
  if(
    direct_total + isolate_benefited_total + do_benefited_total = 0,
    0.0,
    round(
      do_benefited_total * 100 / (
        direct_total + isolate_benefited_total + do_benefited_total
      ),
      2
    )
  ) AS do_benefited_percent
FROM (
  SELECT
    sumIf(_sample_interval * double1, blob1 = 'direct_upstream') AS direct_total,
    sumIf(
      _sample_interval * double1,
      blob1 = 'benefited' AND blob2 = 'isolate'
    ) AS isolate_benefited_total,
    sumIf(
      _sample_interval * double1,
      blob1 = 'benefited' AND blob2 = 'do'
    ) AS do_benefited_total
  FROM rsshub_balancer_metrics
  WHERE timestamp > NOW() - INTERVAL '1' DAY
    AND blob1 IN ('direct_upstream', 'benefited')
)
```

## 最近 24 小时请求 Method 分布

请求入口会用 `route_request` 指标记录收到的请求，method 存在 `blob4`。这个 SQL 用来查看当前时间窗口内实际收到过哪些 HTTP methods，以及每种 method 的近似请求数。

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

## 最近 24 小时 upstream 请求数量

真实打到上游的请求会用 `direct_upstream` 指标记录，最终触达的 upstream 存在 `blob7`。这个 SQL 用来查看各 upstream 在实际请求中的近似请求数。

注意：`blob7` 表示这条 `direct_upstream` 指标对应请求最终触达的 upstream，不是每次 retry attempt 的展开记录。如果一次入口请求先后尝试多个 upstream，当前统计只会把这次请求计入最终触达的那个 upstream；它适合观察最终承接流量占比，不适合观察真实出站 attempt 分布。

```sql
SELECT
  blob7 AS upstream,
  sum(_sample_interval * double1) AS direct_total
FROM rsshub_balancer_metrics
WHERE timestamp > NOW() - INTERVAL '1' DAY
  AND blob1 = 'direct_upstream'
  AND blob7 != 'none'
GROUP BY blob7
ORDER BY direct_total DESC
```
