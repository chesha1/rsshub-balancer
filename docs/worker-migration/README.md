# 云下迁移方案

方案待实施。为减少 Workers CPU Time 和费用，让已有服务器上的单进程 Node/Hono 承接日常 RSS，使用 Docker Compose + Traefik，保留 Cloudflare 橙云及现有 Worker 作为备用。首次迁移、故障接管和恢复均手动切换。

## 接口归属

域名和现有 URL 不变：`rsshub-balancer.virworks.moe`。

| 请求 | 正常及恢复后 | 故障接管 |
| --- | --- | --- |
| `/`、`/_assets/*` | Worker Static Assets | 同一份 Static Assets |
| `POST /_internal/metrics/ingest` | Worker binding 写入指标 | 同左 |
| RSS、`GET /_internal/upstreams`、`GET /_internal/metrics/country-colo-sankey`、`GET /api/route/status`、`GET /healthz` | Node | Worker |

业务查询与 RSS 一起切换，前端始终请求同域相对路径。Node 故障但尚未接管时，首页可打开，动态查询显示暂不可用。`/healthz` 保留上游聚合语义：至少一个上游在单次 5 秒探测内健康返回 200，否则 503；不用于容器重启。

`/_internal/upstreams` 使用当前运行时的 `getUpstreams()`，返回 `{ "upstreams": [...] }`；非 GET 返回 `405 / Allow: GET`，带 query 返回 400。首页两种语言均说明这是当前承接环境的候选列表；该接口不计入 RSS 指标。

## 路由

DNS 橙云记录指向 Traefik → Node balancer，业务 hostname 不保留 Worker Custom Domain。正常时只保留三条长期 Routes，均指向 `rsshub-balancer`：

```text
rsshub-balancer.virworks.moe/
rsshub-balancer.virworks.moe/_assets/*
rsshub-balancer.virworks.moe/_internal/metrics/ingest
```

接管时增加 `rsshub-balancer.virworks.moe/* -> rsshub-balancer`，恢复时删除它。日常切换只改这条 catch-all，DNS、长期 Routes、缓存规则和 Redis 状态不随之修改。

Route 匹配包含 query：用 Single Redirect 将带 query 的首页规范化到 `/`，`/index.html` 也推荐跳转到 `/`。ingest 固定使用无 query、无尾斜线的精确 URL，不扩大为内部接口通配 Route。[Route 匹配规则](https://developers.cloudflare.com/workers/configuration/routing/routes/)

首次迁移清理旧 `/_internal/*`、`/_internal/metrics/*`、业务查询专用 Routes 及干扰接管的 no-script 规则。Routes 在 zone 管理，不写入 Wrangler；`pnpm deploy` 只发布 Worker 代码、bindings 和静态资源。

## 实施分工

| 文档 | 内容 |
| --- | --- |
| [共享运行时](./shared-code-runtime-plan.md) | 双入口、配置、Redis、Node 生命周期和代理差异 |
| [指标回传](./sankey-analytics-engine-ingestion-plan.md) | ingest 协议、字段、查询与前端 |
| [缓存](./zone-cache-plan.md) | Cache Rule、响应头和验证 |
| [操作手册](./migration-failover-runbook.md) | 首次迁移、接管、发布、恢复和回滚 |

Worker 保留前后端组合部署：`assets.directory=dist/apps/web`，构建依赖 Web；`not_found_handling=none`，缺失静态文件返回 404。`run_worker_first` 保留内部接口、API、健康检查及 `robots.txt` 的脚本优先设置，Hono catch-all 保留备用 RSS 后端；Node 只部署后端。这些资产设置与域名 Routes 分别管理。

本次只处理迁移所需适配。现有选路、超时、fallback 等缺陷留在 [TODO](../todo.md)，不扩大为迁移前置改造；自动化在首次迁移后按需接入，见操作手册。
