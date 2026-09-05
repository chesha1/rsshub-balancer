# 云下 RSS 的 Zone Cache 方案

- 方案状态：已确认，尚未实施
- 决策日期：2026-09-05
- 适用域名：`rsshub-balancer.virworks.moe`
- 适用范围：普通橙云回源到 Node/Hono 的 RSS 响应缓存；本次未读取或修改线上配置

## 结论

**云下 RSS 使用 Cloudflare Zone Cache，通过一条 Cache Rule 默认允许业务路径缓存，只排除前端和少数保留接口。**

- 新增 RSS 路由自动纳入，不维护业务路由白名单，也不按 RSS/XML/JSON 响应格式区分。
- 有上游缓存头时遵循上游；没有时使用 Cloudflare 的默认缓存行为。
- 保留健康检查和内部 API 的 `no-store` 响应策略。
- 前端继续由 Workers Static Assets 管理；故障接管 Worker 保留现有 Workers Cache 配置。
- Node 不为本方案新增应用层响应缓存，普通 RSS 请求无需执行 Worker 脚本。

本方案与现有 Workers Cache 都以轻量实现为目标，允许两侧缓存行为不完全一致，以不影响正常 RSS 业务为边界。

## 轻量缓存原则

已确认的取舍（2026-09-05）：本负载均衡服务优先保障 RSS 请求的正常转发与故障接管。考虑到本项目 RSS 场景对缓存行为的容忍度较高，缓存只作为轻量优化，不以完整实现通用 HTTP 缓存兼容或云上、云下完全对齐为目标。

- 两侧尽量使用平台现有缓存能力，保留适用的上游缓存头和少量路径级 `no-store`。Node 不新增应用层响应缓存，也不为统一两端行为增加复杂缓存逻辑。
- 接受默认 TTL、缓存生命周期以及一般 `Vary` 处理等平台差异，不要求命中结果和所有响应变体逐项一致；一般 `Vary` 的专门适配、自定义变体缓存键和完整对齐验收不作为本次迁移要求。
- 正常 Feed 获取、query 参数区分、健康检查和内部 API 的禁止缓存语义仍须保持。接受平台差异不代表已经验证所有内容协商场景均兼容。
- 若后续确认某个 Feed 的缓存行为影响正常业务，再针对该路径或场景做最小必要调整，不预先扩展为通用缓存兼容层。

## 当前 Workers Cache 基线

以当前仓库源码为准，`apps/server/wrangler.jsonc` 只开启：

```json
"cache": {
  "enabled": true
}
```

`apps/server/src/index.ts` 对以下路径在响应阶段设置 `Cloudflare-CDN-Cache-Control: no-store`：

- `/healthz`
- `/_internal/*`
- `/api/*`

其余响应保留上游响应头，代码没有统一添加固定 TTL、`stale-while-revalidate` 或 `stale-if-error`。响应头没有给出缓存策略时，由平台默认行为决定。

这个 middleware 控制的是 Worker 执行后的响应能否存储，不会跳过执行前的 Workers Cache 查找。前端静态资源还受 Static Assets 自身的路由和缓存机制管理。

## 正常状态的数据流

```text
公开 RSS 请求
  -> 不命中 Worker Route
  -> Cloudflare Zone Cache
       HIT：直接返回缓存响应
       MISS：Traefik -> Node/Hono -> RSSHub upstream
             Node 返回响应后，Cloudflare 按规则和响应头决定是否缓存
```

普通 Zone Cache 默认按文件扩展名等条件判断缓存资格。`/bilibili/user/video/123` 这样的 RSS 路径不会因为响应是 XML 或设置了缓存时间就自动获得缓存资格，因此需要显式配置 Cache Rule。参见 [Zone 默认缓存行为](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)。

## Dashboard 配置

进入 `virworks.moe` 的 **Caching → Cache Rules → Create rule**，创建一条规则，名称可用“RSS 业务路径缓存”。规则中的 hostname 限制确保不会覆盖这个 zone 下其他子域名。参见 [Dashboard 创建规则](https://developers.cloudflare.com/cache/how-to/cache-rules/create-dashboard/)。

选择自定义表达式，在表达式编辑器粘贴：

```text
(http.host eq "rsshub-balancer.virworks.moe")
and not (
  http.request.uri.path in {
    "/" "/index.html"
    "/healthz"
    "/api" "/_internal" "/_assets"
  }
  or starts_with(http.request.uri.path, "/api/")
  or starts_with(http.request.uri.path, "/_internal/")
  or starts_with(http.request.uri.path, "/_assets/")
)
```

动作设置如下：

| 设置项 | 取值 |
| --- | --- |
| 缓存资格 | `Eligible for cache` |
| 边缘 TTL | `Use cache-control header if present, use default Cloudflare caching behavior if not` |
| 浏览器 TTL | 遵循源站响应头，不强制覆盖时间 |
| 缓存键 | 保持默认，包含完整 query string |
| Query String Sort | 保持关闭，保留参数顺序 |
| 按状态码指定 TTL | 不添加 |

这里的边缘 TTL 对应 API 的 `respect_origin`。规则只赋予路径缓存资格，实际能否存储以及能保存多久，仍由响应缓存指令和平台行为决定。参见 [Cache Rules 设置](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)、[Zone 缓存键](https://developers.cloudflare.com/cache/how-to/cache-keys/)。

### 为什么同时使用 `in` 和 `starts_with`

`in` 匹配集合中的完整路径，`starts_with` 匹配目录下的所有路径。集合中的 `"/api/*"` 不会被当作通配符。

| 请求路径 | 规则结果 | 原因 |
| --- | --- | --- |
| `/healthz` | 排除 | 精确路径 |
| `/api` | 排除 | 精确目录名 |
| `/api/route/status` | 排除 | `/api/` 前缀 |
| `/api/upstreams` | 排除 | 首页当前上游列表，随承接环境切换 |
| `/_internal/metrics/ingest` | 排除 | `/_internal/` 前缀 |
| `/_assets/app.js` | 排除 | 前端资源 |
| `/apix/feed` | 允许尝试缓存 | 不属于 `/api/` 命名空间 |
| `/bilibili/user/video/123` | 允许尝试缓存 | 普通 RSS 路由 |
| `/robots.txt` | 允许尝试缓存 | 固定内容，无需专门排除 |

路径判断不包含 query，因此 `/healthz?check=1` 仍被排除；RSS 的 query 则继续参与缓存键，不同参数不会被主动合并。精确 `/healthz` 不包含 `/healthz/`；后续若新增末尾斜杠别名或 `/livez`、`/readyz` 等探针，应同步维护排除集合和响应头策略。

## 单条规则的排除边界

**不匹配这条规则，只表示本规则不改变该请求的缓存设置，不等于显式执行 Bypass cache。**

单条规则方案依赖以下已确定的边界：

- Node 迁移时保留健康检查和内部 API 的禁止缓存语义。保留 `Cloudflare-CDN-Cache-Control: no-store`，并按部署分析补充标准 `Cache-Control: no-store`，供普通 HTTP 缓存识别。
- `/`、`/index.html` 和 `/_assets/*` 只是不参与 RSS 缓存策略，不禁用 Static Assets 自身的缓存。
- 上线前读取目标 hostname 实际匹配的 Cache Rules、相关 Page Rules 和 Cache Response Rules，确认没有其他规则强制缓存保留路径、覆盖 `no-store` 或忽略 query。

Cache Rules 的冲突设置由最后匹配的规则决定；排除表达式不会撤销其他规则已经设置的行为。首版采用一条规则加应用响应头，不另加一条全局 bypass 规则。参见 [规则优先级](https://developers.cloudflare.com/cache/how-to/cache-rules/order/)。

## 轻量缓存边界与平台差异

两侧继续按响应缓存头决定缓存行为。Cloudflare 的缓存头优先级是 `Cloudflare-CDN-Cache-Control`、`CDN-Cache-Control`、`Cache-Control`；Node 应正确保留适用的上游响应头，不统一改写所有 Feed 的缓存时间。参见 [CDN 缓存头](https://developers.cloudflare.com/cache/concepts/cdn-cache-control/)。

下面是 2026-09-05 官方文档中没有缓存头、也没有 `Expires` 时的默认 TTL 快照；表中的默认不缓存不表示显式缓存指令下也绝对不能缓存。

| 状态码 | Workers Cache | Zone Cache |
| --- | --- | --- |
| 200 | 2 小时 | 2 小时 |
| 203、204 | 2 小时 | 默认不缓存 |
| 206 | 默认不缓存 | 2 小时 |
| 300 | 20 分钟 | 默认不缓存 |
| 301 | 20 分钟 | 2 小时 |
| 302、303 | 默认不缓存 | 20 分钟 |
| 404、410 | 3 分钟 | 3 分钟 |
| 405、414、501 | 1 分钟 | 默认不缓存 |

来源：[Workers Cache 配置](https://developers.cloudflare.com/workers/cache/configuration/#cache-control-semantics)、[Zone 默认 TTL](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/#edge-ttl)。

不通过 Dashboard 的状态码 TTL 表强行复制上述 Worker 默认值，因为该设置会覆盖源站缓存指令，改变“有缓存头就遵循”的约定。上述对比用于说明已接受的平台差异，不是逐项对齐清单；后续仅在出现影响正常 RSS 业务的具体问题时做局部处理。参见 [按状态码缓存](https://developers.cloudflare.com/cache/how-to/configure-cache-status-code/)。

## 故障接管与恢复

增加 catch-all Worker Route 后，公开 RSS 由现有 Worker 接管，继续使用其 Workers Cache 和路径级 `no-store`；Zone Cache Rules 不控制 Workers Cache。两套缓存不共享条目，也不在切换时复制或迁移缓存。参见 [Workers Cache 平台边界](https://developers.cloudflare.com/workers/cache/)。

Worker 默认缓存键包含部署版本，Node 的发布不会自动让 Zone 缓存更换版本。正常 TTL 继续生效；发布若确实需要立即替换缓存内容，应按受影响 URL 清理对应 Zone 缓存。恢复到 Node 时，Zone 中仍有效的缓存可以继续服务，不假定切换会自动清空缓存。参见 [Worker 缓存键](https://developers.cloudflare.com/workers/cache/cache-keys/)。

Zone HIT 不执行 Node，也不会生成 Node 的 `route_request` 指标；这符合已经确认的桑基图口径，无需改变数据回传方案。

## 实施验证

- 本文是待实施配置，Dashboard 是否已创建规则必须以实际读取为准。
- 用 Cloudflare Trace 或 Dashboard 规则测试核对：仅目标 hostname 匹配，普通 RSS 命中，精确保留路径及目录子路径不命中，`/apix/feed` 不被误伤。
- 对可缓存的同一 Feed 连续请求，结合 `CF-Cache-Status`、`Age` 和 Node/Traefik 日志确认缓存命中；仅“命中 Cache Rule”不能证明响应已经存入缓存。
- 健康检查和内部 API 保留禁止缓存响应头，重复请求不会返回存储的诊断结果；前端资源仍按 Static Assets 行为提供。
- 计划中的 `/api/upstreams` 在 Node、Worker 均禁止缓存；旧 `/_internal/upstreams` 的过渡重定向也禁止缓存，页面重新查询时不会沿用切换前的 HTTP 缓存列表。
- 不同 query 的 Feed 分别读取正确内容；不通过忽略参数或排序参数提高命中率。
- 验证带缓存头和不带缓存头的响应分别采用源站策略及 Zone 默认值；不强求所有状态码与 Worker 一致。
- 分别确认 Node 和 Worker 能正常提供代表性 Feed；不增加一般 `Vary` 的完整兼容矩阵，也不将两端缓存行为完全一致作为迁移验收条件。
- 实际执行普通 RSS 的日志来自 Node；Zone HIT、MISS 都不因这条规则新增 Worker invocation。故障切换时按前端方案单独验证 Worker 接管。

回滚时停用本次新增的单条 Cache Rule；普通请求恢复到 zone 原有缓存资格设置，不改变 DNS 或 Workers Routes。停用规则不等于清除已有缓存，若需要立即清除错误内容，应清理受影响的 URL。

## 相关方案

- [前端单副本与 Worker 后端故障接管方案](./frontend-worker-failover-plan.md)
- [云下桑基图数据回传 Analytics Engine 方案](./sankey-analytics-engine-ingestion-plan.md)
- [Node/Hono 部署可行性与 Cloudflare 依赖审计](./node-hono-deployment-analysis.md)
