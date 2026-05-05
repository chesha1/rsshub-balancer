# Metrics 查询

## 最近 24 小时合并收益

合并收益统计写入 Workers Analytics Engine 数据集 `rsshub_balancer_metrics`。指标是近似统计，查询时需要使用 `_sample_interval` 修正采样。

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
