# Metrics 查询

入口请求统计写入 Workers Analytics Engine 数据集 `rsshub_balancer_request_flows`，只保存来源国家/地区和最终上游。Worker 直接写 binding，Node 将 `{ events: [...] }` 批量上传到 Worker 的 `POST /_internal/metrics/ingest`；每个事件只含 `country`、`upstream`。回传与启用约定见[指标回传](./worker-migration/sankey-analytics-engine-ingestion-plan.md)，部署进度见[实施状态](./worker-migration/implementation-status.md)。

当前格式从 `blob1` 重新排列，不保留旧列位置、版本号或旧数据查询逻辑。使用新数据集与旧格式数据隔离，并配套发布写入端、查询端和首页；新图表从新请求开始积累。Worker binding 名称仍为 `METRICS`，指向 `rsshub_balancer_request_flows`；平台会在首次写入时自动创建数据集，见[官方说明](https://developers.cloudflare.com/analytics/analytics-engine/get-started/#1-name-your-dataset-and-add-it-to-your-worker)。

## 记录范围与字段

进入完整选路、到达现有记录位置的 GET/HEAD 请求每次写入一个数据点，只记录最终结果。Cache HIT、入口拒绝和 `DIRECT_FALLBACK_RATE` 前置直转仍不计入；前置直转的漏记修复见 [TODO](./todo.md#前置-fallback-请求的桑基图漏记)。完整选路内部的 fallback 和重试继续记录最终结果。

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

接口保留 `{ rows, generatedAt, windowHours: 24 }`，每行为 `{ country, upstream, value }`，`value` 来自 `request_total`。首页默认展示 `country -> upstream`，连线宽度、节点总量和悬浮提示均使用这个请求数量。维度复选框和按可见列绘图的逻辑继续保留，当前提供国家和上游两个选项，可自由勾选或取消，不限制最少显示列数；后续新增维度时继续使用同一选择逻辑。

每个数据点代表一次被记录的请求，按平台 `_sample_interval` 求和即可修正采样，无需额外写入固定为 `1` 的计数字段，见 [Analytics Engine 采样说明](https://developers.cloudflare.com/analytics/analytics-engine/sampling/#how-to-read-sampled-data)。最近 24 小时使用平台写入时间 `timestamp`，包含 Node 排队和上传延迟。指标是近似统计，允许丢失，不作为计费、审计或故障切换依据；Node 退出时不额外上传内存队列。
