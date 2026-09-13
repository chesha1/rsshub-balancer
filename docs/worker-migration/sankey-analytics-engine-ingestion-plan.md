# 桑基图指标回传

服务端及必要首页适配已完成本地实现，线上启用仍待执行，见[实施状态](./implementation-status.md)。唯一数据集为 `rsshub_balancer_metrics`：Node 后台批量上传到 Worker ingest，由 binding 写入；Worker 接管时直接调用 `METRICS.writeDataPoint()`。两端共享 HTTP SQL 查询，接口归属见[路由](./README.md#路由)。

## 指标口径

- 统计最近 24 小时进入完整选路、到达现有记录位置的 GET/HEAD；一次请求只记录最终结果。
- 不计 Cache HIT、入口拒绝和 `DIRECT_FALLBACK_RATE` 前置直转，不补权重推算遗漏流量；完整选路中的 fallback、重试沿用现有记录位置。
- 时间窗口按 Analytics Engine ingest `timestamp`，包含排队及上传延迟，并非原请求完成时间。
- 指标允许丢失，不作为计费、审计或故障切换依据。

## 字段契约

共享业务统一调用 `metrics.ts` 的 `recordRouteRequestMetric()` 记录 `RouteRequestMetric`，每事件一点；类型、常量和 `toMetricDataPoint()` 映射集中于 `metrics-schema.ts`，Worker 直接写入与 ingest 共用 `adapters/metrics-worker.ts`，历史数据不改写：

| 字段 | 固定值或含义 |
| --- | --- |
| `index1` / `blob1` | `global` / `route_request` |
| `blob2` / `blob10` | Node：`origin` / `origin`；Worker：`edge` / `worker_failover` |
| `blob3` / `blob9` / `blob11` | `none` / 空字符串 / `2` |
| `blob4` / `blob5` / `blob6` | method / outcome / 状态码字符串 |
| `blob7` / `blob8` | 最终 upstream（缺失为 `none`）/ country |
| `double1` / `double2` | `1` / durationMs |

country 取原始 RSS 请求：Node 直接读取 `CF-IPCountry`；Worker 优先使用 `request.cf.country`，未提供时读取 `CF-IPCountry`。缺失或空值为 `unknown`，不检查国家代码格式。origin 须限制为 Cloudflare 或可信代理来源；ingest 不得用上传请求的地域覆盖 payload。历史空 plane 查询时归为 `legacy_worker`。

## Node 批量提交

- [metrics-node.ts](../../apps/server/src/adapters/metrics-node.ts) 在模块内保存队列、上传任务、丢弃计数和定时器。Node 入口只调用一次 `configureMetrics('node')`，由 `metrics.ts` 读取 `METRICS_INGEST_URL` 并在内部调用 `startMetricsUpload()` 启用上传；共享应用调用 `recordRouteRequestMetric()`，由 `metrics.ts` 按入口配置调用 `nodeMetrics.recordMetric()` 入队，未启用时不入队。导入模块不启动上传或定时器，同一运行环境重复初始化不会多开定时器。
- 配置 `METRICS_INGEST_URL` 即启用上传，无需 ingest token；留空时关闭上传。配置要求见[实施状态](./implementation-status.md#本地运行)。
- 请求完成后只入队，不等待上传。达到 100 条或每 15 秒触发；每批最多 200 条，同一进程单批串行，单批上传限 5 秒。
- 队列积压上限为 2000 条；超限丢最旧指标，以 `droppedEventCount` 汇总本地 warning。
- 为避免响应不确定时重复计数，开始发送即从队列移除，每批只尝试一次；超时、非 2xx 均不放回，累计丢失数且不影响 RSS。
- SIGINT/SIGTERM 按 Node 默认行为终止进程，不等待上传或执行退出提交。内存中最多 2000 条待发事件会丢失，另有最多 200 条在途事件的接收结果可能未知；15 秒触发周期不是积压事件的最长等待时间。退出约定见[刷新与退出](./shared-code-runtime-plan.md#刷新与退出)。

## Ingest 接口

```text
POST /_internal/metrics/ingest
Content-Type: application/json
```

请求为 `{ schemaVersion: 2, events: [...] }`，每个事件仅含 `method`、`status`、`durationMs`、`outcome`、`upstream`、`country`。

- 仅允许 POST，其余返回 `405` 与 `Allow: POST`；不接受 query，不启用 CORS，URL 边界见[路由](./README.md#路由)。
- 来源限制由 Cloudflare WAF 自定义规则执行：访问 ingest 路径且来源不在服务器公网出口 IP 白名单中时 Block。Worker 不再校验 ingest token；部署时确保该接口没有绕过 WAF 的公开入口，不记录原始 body。
- 指标由本服务按固定格式生成；Worker 本地写入与 ingest 都直接消费事件，不做 schema、版本、字段数量、枚举、数值范围、字符串格式或长度的运行时校验。ingest 解析 JSON 后读取 `events`，按当前 v2 约定映射写入；每批最多 200 条由 Node 发送端组批控制。
- payload 只传上述事件字段，不上传 IP、path、query、Cookie、Authorization 或完整 headers。dataset、index、blob 位置由代码固定，ingest 调用 Worker 写入函数时显式传入 `origin`，固定补 `layer=origin`、`plane=origin`；Worker 自身请求使用 `worker_failover`。
- 调用非阻塞 binding 后返回 `204`，仅表示已调用，不证明持久化；handler 自身不生成业务指标，所有响应带[双 no-store 头](./zone-cache-plan.md#两端共享的响应头中间件)。

## 查询与前端

- 保留 `GET /_internal/metrics/country-colo-sankey`，外层为 `rows`、`generatedAt`、`windowHours: 24`；每行为 `country`、`outcome`、`upstream`、`value`。
- 固定 SQL 按 `blob8/5/7` 聚合，忽略历史 `blob9` 机房；保留 `blob1=route_request`、`blob5=direct_upstream` 过滤，以 `sum(_sample_interval * double1)` 得到 value；空或 `none` upstream 映射为 `not_recorded`。
- 两端共享 handler、解析和错误处理，不接受浏览器传任意 SQL。配置 `CLOUDFLARE_ACCOUNT_ID`、具备 Account Analytics Read 权限的 `CLOUDFLARE_ANALYTICS_API_TOKEN`。
- 前端移除 `edgeColo`，同步类型、校验、维度选择、文案及无障碍描述，展示 `country -> outcome -> upstream`；API 与前端配套发布及回滚。

## 启用与回滚

启用前核对账户 Workers 计划、[当前计费](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)及真实流量。批量上传不减少 data points；Free 接近日额度时，须先确定升级或调整采集方式，不能无余量上线。

验证 WAF 允许服务器公网出口 IP、阻断其他来源访问 ingest，核对固定字段映射、上传故障不阻塞 RSS，以及正常/接管/恢复均能查询同一数据集。完整切换见[操作手册](./migration-failover-runbook.md)。

可单独关闭 Node 上传，保留历史数据和 Worker binding 写入；查询与前端仍须配套回滚。
