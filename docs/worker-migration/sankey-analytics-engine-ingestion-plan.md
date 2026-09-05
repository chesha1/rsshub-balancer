# 云下桑基图数据回传 Analytics Engine 方案

- 方案状态：数据流方向已确认，尚未实施
- 决策日期：2026-09-04
- 适用域名：`rsshub-balancer.virworks.moe`
- 适用范围：首页 `country -> edge_colo -> outcome -> upstream` 桑基图

## 目标

Node/Hono 迁到云下后，正常公开 RSS 请求不再执行 Worker，但首页桑基图仍需连续展示正常状态和 Worker 故障接管状态下的请求分布。

本方案只统一桑基图依赖的结构化指标数据，不统一日志和 tracing：

- 云下日志继续查看 Node 容器日志。
- 云上日志继续查看 Cloudflare Workers Logs。
- 不为这张图额外建设 OpenTelemetry、日志汇聚或通用指标平台。

## 结论

**继续使用现有 Workers Analytics Engine 数据集 `rsshub_balancer_metrics` 作为桑基图唯一数据源。**

- 正常状态：Node 在内存中缓冲指标，批量调用现有 Worker 的受保护 ingest 接口，再由 Worker binding 写入 Analytics Engine。
- 故障接管状态：处理 RSS 请求的 Worker 继续通过 binding 直接写入同一个数据集。
- 首页读取：现有 `/_internal/metrics/country-colo-sankey` 继续只查询这一个数据集，前端响应结构保持不变。

这里有意接受桑基图数据继续依赖 Cloudflare。前端、长期 `/_internal/*` Route 和故障接管后端本来就保留在同一个 Worker deployment 中；为单张近似统计图引入独立数据库和双数据源查询，收益不足以覆盖额外复杂度。

## 数据流

### 正常状态

```text
公开 RSS 请求
  -> Cloudflare 橙云代理
  -> 云下 Node/Hono
  -> 生成 route_request 指标对象
  -> 写入进程内有界 buffer
  -> 批量 POST /_internal/metrics/ingest
  -> 现有 rsshub-balancer Worker
  -> METRICS.writeDataPoint(...)
  -> rsshub_balancer_metrics
```

普通 RSS 请求本身仍然不命中 Worker Route。只有低频批量指标上传命中已经长期保留的 `/_internal/*` Route。

### 故障接管状态

```text
公开 RSS 请求
  -> 临时 catch-all Worker Route
  -> 现有 rsshub-balancer Worker
  -> 生成同一种 route_request 指标对象
  -> METRICS.writeDataPoint(...)
  -> rsshub_balancer_metrics
```

此时不需要再经过 HTTP ingest 接口，因为当前请求已经处于具有 `METRICS` binding 的 Worker 中。

### 首页读取

```text
首页
  -> GET /_internal/metrics/country-colo-sankey
  -> Worker 调用 Analytics Engine SQL API
  -> 聚合最近 24 小时数据
  -> 返回现有 { rows, generatedAt, windowHours }
```

读取链路不查询 Node，也不需要在故障切换时更换数据源。

## 平台边界

Analytics Engine 的写入接口是 Worker binding `writeDataPoint()`；对外 HTTP SQL API 是查询接口，不提供给普通 Node 使用的等价写入 API。因此 Node 不能直接复用当前 binding，必须通过 Worker 侧的窄 ingest 接口桥接。

这个接口不是通用 metrics gateway，也不接受任意 Analytics Engine 字段。它只接收本项目固定版本的 `route_request` payload。

## 统一指标对象

业务核心应先生成平台无关的指标对象，再由不同运行时 adapter 决定如何提交：

```text
RouteRequestMetric
  schemaVersion = 2
  method
  status
  durationMs
  outcome
  upstream
  country
  edgeColo
```

- Worker adapter：补充 `layer=edge`、`plane=worker_failover` 后，同步调用非阻塞的 `writeDataPoint()` binding。
- Node adapter：只把业务字段放进本地 buffer，不在业务请求中等待网络上传；ingest Worker 固定补充 `layer=origin`、`plane=origin`，不接受 Node 指定这两个信任字段。

首版继续保留“每个已纳入现有统计口径的原始请求生成一个指标事件，对应一个 Analytics Engine data point”的语义，便于兼容现有数据和查询；不表示所有入口请求都会生成指标：

| Analytics Engine 字段 | 含义 | Node 正常状态 | Worker 故障接管 |
| --- | --- | --- | --- |
| `index1` | 采样索引 | `global` | `global` |
| `blob1` | metric | `route_request` | `route_request` |
| `blob2` | layer | `origin` | `edge` |
| `blob3` | 保留字段 | `none` | `none` |
| `blob4` | method | 实际 method | 实际 method |
| `blob5` | outcome | 实际 outcome | 实际 outcome |
| `blob6` | status | 状态码字符串 | 状态码字符串 |
| `blob7` | upstream | 最终触达 upstream / `none` | 最终触达 upstream / `none` |
| `blob8` | country | 原始请求的国家/地区 | 原始请求的国家/地区 |
| `blob9` | edge_colo | 原始 `CF-Ray` 后缀所示 colo / `unknown` | 原始请求的 Cloudflare ingress colo / `unknown` |
| `blob10` | plane | `origin` | `worker_failover` |
| `blob11` | schema_version | `2` | `2` |
| `double1` | count | `1` | `1` |
| `double2` | duration_ms | 请求处理耗时 | 请求处理耗时 |

现有桑基图 SQL 只按 `blob8`、`blob9`、`blob5` 和 `blob7` 聚合，因此加入 `origin` 数据、`blob10` 和 `blob11` 不要求改变前端数据结构。历史数据的新增字段为空；如后续查询 plane，需要把空值明确归为 `legacy_worker`，不能静默当成云下数据。

## 指标口径

桑基图继续统计：

> 最近 24 小时进入完整选路处理，并到达现有指标记录位置的 GET/HEAD 请求。

它不表示站点全部公网流量：

- Cloudflare Cache HIT 可以在 Worker 或 origin 代码执行前返回，无法产生这条应用指标。
- 被入口方法检查直接拒绝的请求不进入这项统计。
- 命中 `DIRECT_FALLBACK_RATE` 的前置直转 fallback 请求仍不记录；完整选路内部的 fallback 和重试继续按现有记录位置统计。
- 一次入口请求可能尝试多个 upstream，但桑基图只记录最终结果，不展开每一次 attempt。

已确认范围（2026-09-06）：前置 `DIRECT_FALLBACK_RATE` 分支在 `recordRouteRequestMetric()` 之前返回的漏记属于既有缺陷，本次迁移在 Node 和 Worker 两端均保留。修复已移入 [TODO](../todo.md#前置-fallback-请求的桑基图漏记)，不作为迁移实施或验收要求；这项缺口也不解释为显式采样，不对已记录请求补权重来推算全部流量。

## Node 地域数据来源

ingest Worker 看到的 `request.cf` 属于“Node 发出的批量上传请求”，不是原始 RSS 用户请求。Worker 不得用它覆盖 payload 中的地域字段。

正常状态仍由 Cloudflare 橙云代理进入 Node，因此 Node 可以从原始请求的可信 Cloudflare headers 中提取：

- `country`：`CF-IPCountry`，缺失时写 `unknown`。
- `edgeColo`：解析原始 `CF-Ray` 的 colo 后缀，无法解析时写 `unknown`。

Cloudflare 官方说明，在 Argo Smart Routing 或 Tiered Cache 等场景中，发送给 origin 的 `CF-Ray` 可能反映连接 origin 的数据中心，而不是最初入口数据中心。实施前必须核对当前链路；如果无法保证与 Worker `request.cf.colo` 同义，应在页面和字段文档中明确它是 origin handoff colo，或者让 Node 写 `unknown`，不能无说明地混为同一语义。

只有在 origin 已限制为 Cloudflare 或其它可信反向代理来源时，才能信任这些 headers。公网能够绕过 Cloudflare 直连 origin 时，客户端可以伪造地域字段。

## Node 批量提交

### Buffer

Node 进程维护有界内存 buffer：

- 业务请求完成后只执行一次本地入队。
- buffer 达到条数阈值或时间阈值后，由单独后台任务 flush。
- 同一时刻只允许一个 flush，避免并发重复发送同一批数据。
- buffer 必须设置最大容量；达到上限时丢弃最旧的指标，保留更接近当前时间的数据，并按批次写一条带 `droppedEventCount` 的本地 warning，不能逐事件刷屏或反向阻塞 RSS 请求。
- 优雅退出时可以做一次 best-effort flush，初始最长等待 2 秒且不得突破进程总退出 deadline。

初始阈值可以从 100～200 条或 10～30 秒开始，再按真实流量和 Worker CPU 调整。单个 ingest payload 的硬上限设为 200 条，为 Analytics Engine 每次 Worker invocation 最多 250 个 data points 的限制保留余量。

### 失败语义

指标链路必须 fail-open：

- ingest 超时、鉴权失败、Cloudflare 故障或 Analytics Engine 异常都不能改变业务响应。
- Node 突然退出时允许丢失尚未 flush 的当前 batch。
- Analytics Engine 是近似分析数据，不作为计费、审计或故障切换判定真源。
- Analytics Engine 没有本方案可用的幂等 upsert；在 HTTP 响应不确定时重发可能重复计数。首版采用 at-most-once：flush 开始时从队列摘下 batch，只发送一次；无论超时或非 2xx 都不重新入队，只累计 `droppedEventCount` 并写本地 warning。本方案宁可接受小量缺口，也不在响应不确定后重发整批并放大计数。

### 时间语义

Analytics Engine 自动生成的 `timestamp` 是 ingest Worker 调用 `writeDataPoint()` 的时间，不是 Node 完成原始请求的时间。首次建议的 10～30 秒是触发 batch flush 的时间阈值，不是数据写入延迟的上限。实际偏移还包括等待上一批 flush 完成和网络传输等耗时，因此“最近 24 小时”窗口的边界偏移也可能超过该阈值。

首版不尝试回填 event time。页面展示的是按 Analytics Engine ingest time 计算的近似 24 小时窗口，不应描述成逐请求时间精确的审计数据。

## Ingest 接口

建议复用现有 Worker，新增精确接口：

```text
POST /_internal/metrics/ingest
Authorization: Bearer <METRICS_INGEST_TOKEN>
Content-Type: application/json
```

首版 wire envelope 固定为：

```json
{
  "schemaVersion": 2,
  "events": [
    {
      "method": "GET",
      "status": 200,
      "durationMs": 123,
      "outcome": "direct_upstream",
      "upstream": "https://example.com",
      "country": "JP",
      "edgeColo": "NRT"
    }
  ]
}
```

边界要求：

- 只允许 `POST`；其它 method 返回 `405` 并带正确 `Allow`。
- 使用独立的 `METRICS_INGEST_TOKEN`，不能复用 Cloudflare Account Analytics Read token。
- token 同时只存在于 Node secret 和 Worker secret 中，不进入前端 bundle、日志或仓库。
- Worker 缺少 `METRICS_INGEST_TOKEN` 时必须 fail closed，不能退化成无鉴权写入。
- 在读取和解析 body 之前完成鉴权；不在日志中记录 token 或原始 body。
- 不接受 query string，不启用 CORS；浏览器不应能够直接调用该接口。
- 限制请求体大小和数组长度；超过 200 条直接拒绝整批。
- 只接受 `schemaVersion = 2`，并严格校验枚举、数字范围和字符串长度。
- 必须先验证完整批次，再调用第一次 `writeDataPoint()`；任何一条非法时整批零写入，避免部分提交。
- 不接受客户端指定 Analytics Engine dataset、index、任意 blob 位置、`layer` 或 `plane`；ingest Worker 固定写入 `layer=origin`、`plane=origin`。
- `country`、`edgeColo` 和 `upstream` 使用预期格式及长度；禁止上传 client IP、path、query、Cookie、Authorization 或完整请求 headers。
- 成功接收并调用 binding 后返回 `204`。
- `204` 只表示 Worker 已接受 payload 并调用非阻塞 binding，不证明数据已经持久化。
- 响应同时使用标准 `Cache-Control: no-store` 和 `Cloudflare-CDN-Cache-Control: no-store`。
- ingest handler 自身不生成 `route_request`，避免递归或额外计数。
- 如果 Node 有稳定出口 IP，可以额外配置 WAF/IP allowlist，减少未授权请求消耗 Worker quota；它不能替代应用层 token。

Worker handler 应使用 payload 中原始请求对应的 country/colo，不能使用 ingest 请求自己的 `request.cf`。

## 费用与额度

下面是 2026-09-04 从 Cloudflare 官方文档读取的快照；Analytics Engine 价格和额度可能变化，实施前必须重新读取官方页面和账户实际计划。

| Workers 计划 | Analytics Engine 写入 | SQL API 查询 |
| --- | ---: | ---: |
| Free | 100,000 data points / 日 | 10,000 queries / 日 |
| Paid | 10,000,000 data points / 月，之后每百万点 `$0.25` | 1,000,000 queries / 月，之后每百万次 `$1.00` |

官方当时仍注明 Analytics Engine 尚未实际开始收费，表中价格是提前公布的未来费率；不能据此假设以后一直免费。

每调用一次 `writeDataPoint()` 算一个 data point，与该点使用多少个 blobs、doubles 或 index 字段无关。HTTP 批量只减少 Worker invocation 次数：一批 200 条在 Worker 内调用 200 次 `writeDataPoint()`，仍然计 200 个 data points。

按每天 100,000 个已纳入上述统计口径的请求、每请求对应一个点估算；前置 fallback 等未记录请求不计入这组写入量：

- 30 天为 3,000,000 点。
- 31 天为 3,100,000 点。
- Workers Paid 下约占每月包含量的 31%，没有 Analytics Engine 写入超额费用。
- Workers Free 下正好用满公布的每日写入额度，没有给流量波动、重复提交或新增指标留出余量。

如果每批恰好 200 条，100,000 个点约需 500 次 ingest Worker invocation / 日；实际次数还取决于时间阈值触发的小批次。这部分是 Worker request/CPU 使用量，与 Analytics Engine data points 分开计算。

此外，Workers Free 本身的 Worker 请求额度也是 100,000 次 / 日。若故障接管持续一整天，100,000 个公开 RSS 请求已经用满 Worker 请求额度，尚未计入首页内部接口等请求。因此需要可靠承接全天峰值时，Workers Paid 是独立于 Analytics Engine 之外的实施前提。

### 实施门槛

启用 Node 原始点回传前，必须读取账户实际 Workers 计划、Analytics Engine 当前计费状态和最近真实请求量：

- 已是 Workers Paid：首版可以保持一请求一点，优先保留简单、一致的数据语义。
- 仍是 Workers Free 且可能接近 100,000 请求 / 日：不得直接把一请求一点作为无余量的长期方案；先由用户明确选择升级 Paid，或者另行设计短时间桶聚合/显式加权采样。

如果以后需要降低写入点数，可以由 Node 按 `method/status/outcome/upstream/country/edgeColo` 做短时间桶聚合，并把 `double1` 改为该组请求数、`double2` 改为耗时总和。由于这会改变当前 `double2` 的语义，必须使用新的 schema version，并同步更新查询和文档，不能在旧 schema 下静默混写。

## 查询与前端

现有首页 API 继续返回：

```json
{
  "rows": [],
  "generatedAt": "...",
  "windowHours": 24
}
```

现有 SQL 的计数仍使用：

```sql
sum(_sample_interval * double1)
```

首页不直接接触 Analytics Engine token。Account Analytics Read token 继续只保存在 Worker secret 中，Worker 只执行仓库中固定的聚合 SQL，不接受来自浏览器的任意 SQL。

每次首页加载当前会产生一次 SQL API query。通常这远低于 Free 的 10,000 queries / 日；如果以后真实查询量接近额度，再单独评估固定聚合结果或短 TTL 缓存。当前明确的 `/_internal/*` no-store 策略不在本方案中顺带改变。

## 实施顺序

1. 定义平台无关的 `RouteRequestMetric` 和 schema version。
2. 在完整选路路径的现有记录位置生成平台无关指标对象，保持一次请求只生成一个事件；前置 fallback 分支继续沿用不记录的现状。
3. 在现有 Worker 增加受保护的 `POST /_internal/metrics/ingest` 和独立 secret。
4. Worker 本地路径继续直接写 Analytics Engine，并补充 `layer` / `plane`。
5. Node 增加有界 buffer、单一 flush 循环和 fail-open 行为。
6. 在不切换公开 RSS 流量前，先用测试 payload 验证鉴权、字段映射和 SQL 聚合。
7. 云下正式承接流量后，核对 `origin` 与 `worker_failover` 数据在同一 24 小时窗口中连续出现。
8. 按真实 data points、SQL queries、Worker invocations 和 CPU 使用量决定是否需要聚合或调整计划。

## 验证清单

- 无 token、错误 token、错误 method、超大 body、超过 200 条和非法字段均被拒绝。
- Worker 未配置 ingest secret 时拒绝全部上传；malformed JSON、空 batch 和 201 条 batch 均整批零写入。
- 合法 Node batch 写入后，Analytics Engine 字段位置与 Worker 直接写入一致。
- Node country/colo 来自原始请求，而不是批量上传请求的 `request.cf`。
- ingest 不可用、超时或返回 5xx 时，RSS 响应状态、响应头和耗时不受等待影响。
- 同一 batch 不会被并发 flush 两次。
- 响应不确定的 batch 不会重新入队；overflow 和 SIGTERM 分别符合丢弃最旧数据与 2 秒 flush deadline。
- ingest 请求自身不产生 `route_request`；Node 完整选路路径的成功和 502 请求各自只生成一个指标事件，前置 fallback 分支继续不记录，与 Worker 的既有统计边界一致。
- Worker 故障接管时不调用 HTTP ingest，而是直接写 binding。
- 切换前后的桑基图没有数据源切换、双源相加或前端 schema 变化。
- 历史 `blob10` 空值不会被错误归类成 `origin`。
- 最近 24 小时窗口按 ingest time 计算，测试结果没有把原始请求完成时间误当成 Analytics Engine `timestamp`。
- 当前图表文案明确不包含 Worker/Zone Cache HIT。
- 当前账户计划和最新官方额度已在实施前重新读取。

## 回滚

回滚不需要迁移或删除历史 Analytics Engine 数据：

1. 关闭 Node 指标 flush。
2. 保留或移除 ingest handler 均不影响公开 RSS 路由。
3. Worker 故障接管路径继续使用原有 binding 写入。
4. 首页继续查询同一个数据集，只是没有新的 Node 数据点。

## 不采用的方案

### 每个 Node 请求同步调用 Worker

会把指标网络调用放回请求热路径，并让 Worker invocation 随 RSS 请求线性增长；不符合迁移目标。

### Analytics Engine 与 Node 数据库在查询时合并

会引入两个时间窗口、两套采样/精度语义、partial response、超时和重复计数问题。它适合短期迁移核对，不适合作为首页长期路径。

### 为桑基图单独建设 PostgreSQL、ClickHouse 或完整可观测平台

可以消除 Analytics Engine 依赖，但数据库必须位于独立故障域，Worker 还要实现外发、鉴权和失败处理。当前只有一张近似桑基图，没有足够收益支撑这套基础设施。

### 用日志派生桑基图

日志已明确保持平台本地查看；为单张图统一日志链路会扩大本次迁移范围。

## 参考资料

- [Cloudflare Analytics Engine：写入 binding 与 SQL 查询](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)
- [Cloudflare Analytics Engine：Pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
- [Cloudflare Analytics Engine：Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [Cloudflare Analytics Engine：Sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/)
- [Cloudflare HTTP request headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
- [Cloudflare Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [前端单副本与 Worker 后端故障接管方案](./frontend-worker-failover-plan.md)
- [Node/Hono 云下部署可行性与 Cloudflare 依赖审计](./node-hono-deployment-analysis.md)
- [当前 Metrics 字段与查询](../metrics.md)
