# 迁移、发布与故障接管

本手册执行[总方案](./README.md)；所有切换均需验证实际流向，不能只看 API 成功或页面内容相同。

## 首次迁移

准备期间保留原入口服务。

1. **保存现场**：读取线上 Routes、独立的 Custom Domains 列表、DNS、缓存/重定向规则及 `my-servers` 有效配置，备份受影响配置与可回滚版本。
2. **准备 Worker**：完成共享运行时、独立 Redis 状态、ingest、查询和前端适配，验证原有 RSS 后端仍可接管。
3. **准备 Node**：完成容器、Traefik、TLS、配置及初始化；通过本机或受控入口验证 Node 的 `/healthz`、Feed GET/HEAD、业务查询和指标回传。经 Traefik 验证时保留正确 Host。
4. **切到 Node**：建立[三条长期 Routes](./README.md#路由)，清理旧规则，完成 DNS/Custom Domain 转换，确认 origin 已从旧的直接 RSSHub 改为 Node balancer，配置首页重定向和缓存规则，最后删除 catch-all。
5. **公开验收**：按下文清单读回配置、验证执行位置；失败则恢复 catch-all 并核对。跨 DNS/Custom Domain 的转换失败时，按现场备份恢复受影响资源。

存在 Custom Domain 时，先备好 zone Route、反代和证书，再移除绑定并立即核对 DNS；若记录被一并删除，补建橙云记录。转换期间保留指向原 Worker 的 catch-all，准备完成后再删；这些操作不是原子的。

## 接管与恢复

- **接管**：重新读取 Routes，创建或确认 `rsshub-balancer.virworks.moe/* -> rsshub-balancer`；读回 pattern/script，并验证公开请求到达 Worker。确认前保留旧 Node。
- **恢复**：修复 Node 后，先通过本机或受控入口验证版本、启动、Feed 和查询，再删除上述 catch-all，确认公开请求回到 Node。接管中的公开 `/healthz` 不能证明 Node 恢复。
- **异常**：未知脚本、no-script 或干扰规则先人工核对，不批量覆盖；API 超时先读回实际结果，不盲目反向切换。接管验证失败保留接管 Route；恢复后异常则重新接管，再排查 Node。

通过 Dashboard 操作即可；使用 API 时先列出完整 Routes，创建只针对约定 catch-all，删除 ID 必须来自本次列表且 pattern/script 精确匹配。检查 HTTP 状态和 JSON `success`，给 API 与公开验证设置有限超时；结果无法核实则报告未知，不记成功。[Routes API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/)

## 发布与回滚

应用代码和镜像构建留在本仓库；Compose、Traefik、TLS 和服务器部署配置放在同级 `my-servers`。GitHub Actions 构建并推送明确版本镜像，由操作者决定更新时间，真实密钥只在运行环境注入。

日常发布顺序：

1. 保留上一版 Worker、Node 镜像及配置，预先确认新镜像可拉取、备用 Worker 可用。
2. 确认 Worker 已接管，再用 Compose 只更新 balancer，不停 Redis、Traefik 或备用端依赖的上游。
3. 直接验证新 Node 版本、启动日志、业务和指标；通过后手动恢复并公开验收。

新版本失败时保持 Worker 接管，恢复旧 Node 镜像和配置后重验；不清空两端 Redis 状态，同一指标格式下保留已有数据。Compose 设置 `init: true`（直接运行镜像时使用 `docker run --init`），由轻量 init 作为 PID 1 转发 SIGTERM，Node 按默认行为终止。未启用 init 时，Node 直接作为 PID 1 可能忽略停止信号，直到容器超时强杀，见 [Node 镜像信号说明](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md#handling-kernel-signals)。应用不等待在途请求、刷新或指标上传，允许中断未完成请求并丢失未上传指标。`stop_grace_period` 是容器运行时强制终止前的等待上限，不对应应用内清理期限。

业务改动默认用同一源码配套构建、验证两端，适配层修复可在兼容时单侧发布。指标写入、查询结构和前端配套发布、回滚。当前国家、上游两字段格式使用新数据集 `rsshub_balancer_request_flows`，Worker 的 `METRICS` binding 与两端查询表名必须一致；若回滚指标格式，同步恢复匹配的数据集绑定与查询表名，避免同一数据集混用列映射。

## 验收

正常、接管、恢复三种状态使用同一清单；协议和运行时边界按各主题文档验证。

| 范围 | 通过条件 |
| --- | --- |
| 流向与业务 | Route API 读回正确；确认 MISS 的 Feed 和各业务查询通过请求 ID 对应 Node/Traefik 或 Worker 日志，覆盖 GET/HEAD、405/404、响应头、压缩及流式响应 |
| 首页与固定接口 | 首页、静态资源及 ingest 始终可用，缺失静态文件 404；刷新首页后的上游列表来自当前运行时 |
| 运行时 | 配置与双目标构建、缓存刷新/失败标记、Redis 隔离/复用/断线/超时及默认信号终止通过；确认停止 Node 后 Redis 已有状态保留，核对可信 header、真实 IP 和反代来源限制 |
| 指标 | WAF 允许服务器公网出口 IP、阻断其他来源访问 ingest，且无绕过 WAF 的公开入口；国家、上游两列映射正常，两端统计口径一致；上传失败不影响 RSS；写入绑定和查询均指向 `rsshub_balancer_request_flows`，前端使用同一格式 |
| 缓存 | 通过[缓存验证](./zone-cache-plan.md#验证与回滚)，实时接口不返回旧诊断结果；需立即更新时只清理受影响 Feed |

日志级别须能留下实际验证证据，不能依赖默认未输出的 info 日志。API 读回与单点公开验证不代表全球同时完成传播；接管也只移动 balancer，Redis、fallback 和上游仍可能共享故障。

## 后续自动化

首次迁移不依赖额外探活域名、token、Worker、Actions 或 DO。需要自动化时再接入独立探活 Worker 自动接管、两个手动 Actions 接管/恢复，直接操作同一 catch-all；先观察和演练，恢复始终手动。

届时再确定探活入口、来源标记、鉴权、阈值和 API 重试参数，并验证 Worker 的公网 fetch 路由及 Cron/Actions 并发。首版不预设无人使用的运维接口。
