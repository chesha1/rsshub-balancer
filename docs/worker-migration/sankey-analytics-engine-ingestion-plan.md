# 桑基图指标回传

待实施。唯一数据集为 `rsshub_balancer_metrics`：Node 后台批量上传到 Worker ingest，由 binding 写入；Worker 接管时直接调用 `METRICS.writeDataPoint()`。两端共享 HTTP SQL 查询，接口归属见[路由](./README.md#路由)。

## 指标口径

- 统计最近 24 小时进入完整选路、到达现有记录位置的 GET/HEAD；一次请求只记录最终结果。
- 不计 Cache HIT、入口拒绝和 `DIRECT_FALLBACK_RATE` 前置直转，不补权重推算遗漏流量；完整选路中的 fallback、重试沿用现有记录位置。
- 时间窗口按 Analytics Engine ingest `timestamp`，包含排队及上传延迟，并非原请求完成时间。
- 指标允许丢失，不作为计费、审计或故障切换依据。

## 字段契约

共享核心生成 `RouteRequestMetric`，每事件一点；Worker adapter 与 ingest 共用映射，历史数据不改写：

| 字段 | 固定值或含义 |
| --- | --- |
| `index1` / `blob1` | `global` / `route_request` |
| `blob2` / `blob10` | Node：`origin` / `origin`；Worker：`edge` / `worker_failover` |
| `blob3` / `blob9` / `blob11` | `none` / 空字符串 / `2` |
| `blob4` / `blob5` / `blob6` | method / outcome / 状态码字符串 |
| `blob7` / `blob8` | 最终 upstream（缺失为 `none`）/ country |
| `double1` / `double2` | `1` / durationMs |

country 取原始 RSS 请求：Node 使用可信 `CF-IPCountry`，Worker 使用 `request.cf.country`，缺失或异常为 `unknown`。origin 须限制为 Cloudflare 或可信代理来源；ingest 不得用上传请求的地域覆盖 payload。历史空 plane 查询时归为 `legacy_worker`。

## Node 批量提交

- 请求完成后只入队，不等待上传。按数量或时间触发，初始可用 100～200 条或 10～30 秒；每批最多 200 条，同一进程单批串行。
- 队列设积压上限，具体值实施时确定；超限丢最旧指标，以 `droppedEventCount` 汇总本地 warning。
- 为避免响应不确定时重复计数，开始发送即从队列移除，每批只尝试一次；超时、非 2xx 均不放回，累计丢失数且不影响 RSS。
- SIGTERM 最后尝试上传最多等 2 秒，不突破进程总退出时限；突然退出允许丢失。收尾顺序见[刷新与退出](./shared-code-runtime-plan.md#刷新与退出)。

## Ingest 接口

```text
POST /_internal/metrics/ingest
Authorization: Bearer <METRICS_INGEST_TOKEN>
Content-Type: application/json
```

请求为 `{ schemaVersion: 2, events: [...] }`，每个事件仅含 `method`、`status`、`durationMs`、`outcome`、`upstream`、`country`。

- 仅允许 POST，其余返回 `405` 与 `Allow: POST`；不接受 query，不启用 CORS，URL 边界见[路由](./README.md#路由)。
- 先鉴权再读 body；独立 token 未配置时拒绝，不记录 token 或原始 body。读取方式见[配置与构建](./shared-code-runtime-plan.md#配置与构建)。
- 限制 body 大小，events 为 1～200 条；严格校验版本、枚举、数字范围、字符串格式及长度，完整批次验证通过后再写，任一非法则整批零写入。
- 禁止指定 dataset、index、blob 位置、layer、plane 或上传 IP、path、query、Cookie、Authorization、完整 headers。ingest 固定补 `layer=origin`、`plane=origin`。
- 调用非阻塞 binding 后返回 `204`，仅表示已调用，不证明持久化；handler 自身不生成业务指标，所有响应带[双 no-store 头](./zone-cache-plan.md#两端共享的响应头中间件)。

## 查询与前端

- 保留 `GET /_internal/metrics/country-colo-sankey`，外层为 `rows`、`generatedAt`、`windowHours: 24`；每行为 `country`、`outcome`、`upstream`、`value`。
- 固定 SQL 按 `blob8/5/7` 聚合，忽略历史 `blob9` 机房；保留 `blob1=route_request`、`blob5=direct_upstream` 过滤，以 `sum(_sample_interval * double1)` 得到 value；空或 `none` upstream 映射为 `not_recorded`。
- 两端共享 handler、解析和错误处理，不接受浏览器传任意 SQL。配置 `CLOUDFLARE_ACCOUNT_ID`、具备 Account Analytics Read 权限的 `CLOUDFLARE_ANALYTICS_API_TOKEN`，与 ingest token 分离。
- 前端移除 `edgeColo`，同步类型、校验、维度选择、文案及无障碍描述，展示 `country -> outcome -> upstream`；API 与前端配套发布及回滚。

## 启用与回滚

启用前核对账户 Workers 计划、[当前计费](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)及真实流量。批量上传不减少 data points；Free 接近日额度时，须先确定升级或调整采集方式，不能无余量上线。

验证 ingest 非法批次零写入、上传故障不阻塞 RSS，以及正常/接管/恢复均能查询同一数据集。完整切换见[操作手册](./migration-failover-runbook.md)。

可单独关闭 Node 上传，保留历史数据和 Worker binding 写入；查询与前端仍须配套回滚。
