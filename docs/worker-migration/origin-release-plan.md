# 云下镜像发布与 Worker 临时接管方案

- 方案状态：已确认默认发布流程，尚未实施
- 讨论日期：2026-09-05
- 适用域名：`rsshub-balancer.virworks.moe`

## 结论

**云下使用单实例 Docker Compose。发布时先手动切到已有 Worker，确认接管后更新云下镜像，直接验证云下新版本，最后手动切回云下。**

```text
云下提供 RSS 服务
  → 手动切到 Worker 并确认接管
  → 云下旧请求收尾，Compose 更新指定版本镜像
  → 直接验证云下新版本
  → 手动切回云下并确认恢复
```

如果新版本有问题，继续让 Worker 提供服务，在云下恢复旧镜像并重新验证，通过后再切回。

本文只约定发布顺序以及云下更新、验证、回滚和退出要求。后续切换入口已确定为两份手动触发的 GitHub Actions：“切到云上”（`switch-to-cloud.yml`）和“恢复云下”（`switch-to-origin.yml`），直接调用 Cloudflare Route API；具体操作与验证方式见 [迁移与故障接管操作手册](./migration-failover-runbook.md)。独立探活 Worker 也直接调用该 API 自动接管，但不会自动切回云下，不引入 DO 或共同控制入口。上述 Worker 和 Actions 尚未实施；启用前可在 Cloudflare Dashboard 手动修改 Workers Routes 完成同样的发布切换。不为发布引入云下蓝绿部署、Swarm、Kubernetes 或多个 Node 副本。

本文描述迁移架构落地后的日常发布，不是从当前 Worker 部署首次迁到云下的全部步骤。首次迁移只准备和验证云上业务 Worker、云下 Node 及两侧配置，再在 Dashboard 手动修改 Workers Routes；探活 Worker、固定探活域名、自动接管专用凭据、两个切换 Actions 和自动接管演练均后置。Node 入口、构建产物、Compose、配置注入等仍需按 [Node/Hono 部署分析](./node-hono-deployment-analysis.md) 实现；本文不表示它们或线上路由分流已经存在。

## 服务器配置所在仓库

**云下服务器的配置统一维护在 `my-servers` 仓库。** 已确认本地检出位置为 `/home/chesha1/Codes/my-servers`，与本仓库 `/home/chesha1/Codes/rsshub-balancer` 同级。

该仓库现有的相关文件包括：

| 文件 | 用途 |
| --- | --- |
| `rsshub.yml` | 现有 RSSHub 及配套服务的 Docker Compose 配置 |
| `traefik.yml` | Traefik 服务的 Docker Compose 配置 |
| `traefik-dynamic.yml` | Traefik 动态配置，包含 TLS 配置 |
| `setup.yml` | Ansible 服务器部署流程 |

后续云下 balancer 的 Compose、反代接入和服务器部署配置应在 `my-servers` 中维护；应用代码、镜像构建定义和本迁移方案留在 `rsshub-balancer`。具体 Compose 文件名在实施时确定，现有 `rsshub.yml` 不代表已经部署了 Node balancer。

## 部署和镜像边界

- 云下运行一个 Node/Hono 容器，由 Traefik 转发请求；镜像只包含后端，前端继续由现有 Worker 的 Static Assets 提供。
- 镜像构建采用此前讨论的 GitHub Actions 构建并推送镜像的方向；Docker Hub 或 GHCR 均可，具体仓库地址和 workflow 在实施时确定，不影响本发布流程。
- 发布选择明确版本，记录源码 commit、镜像 digest 和对应部署配置；保留上一版镜像与配置，回滚复用原产物。
- Redis 地址、鉴权 token 等通过运行时配置注入，不打进镜像。
- 镜像构建完成不自动更新云下，也不自动切换流量。首版由操作者决定何时接管、更新和切回。
- 发布只更新 balancer 服务；不要因更新它而停掉共享 Redis、Traefik 或 Worker 仍依赖的上游服务。

两侧业务代码的配套原则见 [Worker 与 Node 共享代码方案](./shared-code-runtime-plan.md)：日常业务发布默认从同一 commit 构建 Worker 与 Node 两份产物，记录实际 Worker 版本、Node digest、配置及指标协议兼容关系，允许发布和回滚期间暂时运行不同版本。进入下述流程前，确认承担接管的 Worker 版本已验证，且与当前 Node 指标发送端兼容；涉及协议升级时先使接收端兼容新旧格式，再更新发送端。

## 默认发布流程

### 1. 准备版本

确认目标镜像已经构建完成且可拉取，记录当前镜像 digest 与配置作为回滚基线。可以提前拉取新镜像，缩短 Worker 代为服务的时间。

### 2. 手动切到 Worker，并确认接管

Actions 已上线时，手动运行“切到云上”（`switch-to-cloud.yml`）；尚未上线时，在 Dashboard 手动添加指向业务 Worker 的临时 catch-all Route。按 [迁移与故障接管操作手册](./migration-failover-runbook.md) 完成 Worker 接管并确认结果。确认前保留旧 Node 服务，接管未成功时暂停本次更新。

确认接管后，让旧 Node 在途请求按本文的优雅退出要求收尾，再完成容器更新。

### 3. 更新云下镜像

保持 Worker 接管，使用 Compose 将 balancer 服务更新到指定镜像版本。普通 Compose 停止并重建该容器即可，此时公开 RSS 由 Worker 提供。

等待新容器启动并通过本地就绪检查。`docker compose up --wait` 可以辅助等待已配置的健康检查，但业务验证和失败后的回滚仍需单独执行。

### 4. 直接验证云下新版本

通过服务器本机或受控内部入口访问 Node；需要验证反代时，再通过内部路径访问 Traefik 并保留正确的 Host。验证至少包括：

- 实际运行的镜像和预期版本一致，Node 已就绪。
- 代表性 Feed 的 GET/HEAD、响应状态、响应头和内容符合预期。
- 请求确实到达新的 Node，并能通过云下反代入口完成转发。

不能只访问公开域名验证 Node：此时公开 RSS 和计划中的 `/api/upstreams` 都由 Worker 接管；旧 `/_internal/upstreams` 重定向后也取得 Worker 列表。验证新 Node 的当前实例列表时，应通过上述本机或受控内部入口直接访问其 `/api/upstreams`，切回后再验证公开查询返回 Node 列表，见 [首页列表切换约定](./frontend-worker-failover-plan.md#首页当前上游实例列表随承接环境切换)。Node 的就绪检查使用计划中的 `/readyz`；现有 `/healthz` 是上游聚合诊断，不等同于进程就绪。

### 5. 手动切回云下，并确认恢复

云下验证通过后，Actions 已上线时手动运行“恢复云下”（`switch-to-origin.yml`）；尚未上线时，在 Dashboard 手动删除临时 catch-all Route，保留三条长期前端 Routes。按 [迁移与故障接管操作手册](./migration-failover-runbook.md) 确认恢复结果。如果恢复失败，使用同一方式重新添加接管 Route，在云下继续排查或回滚。

Node 发布不会自动清空 Zone Cache。确认新版本时应直接验证云下；只有确实需要立即替换旧内容时，才按受影响 URL 清理缓存。其余沿用 [Zone Cache 方案](./zone-cache-plan.md)。

## 更新失败与回滚

| 失败阶段 | 处理方式 |
| --- | --- |
| 新镜像无法拉取 | 保留当前 Node；若已经接管，则继续由 Worker 服务，待镜像可用后再更新 |
| Worker 接管验证失败 | 不停止旧 Node，暂停本次更新；切换问题按 [迁移与故障接管操作手册](./migration-failover-runbook.md) 处理 |
| 新 Node 启动或业务验证失败 | 保持 Worker 接管，恢复上一版镜像和对应配置，再直接验证云下 |
| 切回云下后发现问题 | 重新启用 Worker 接管，确认后再处理云下 |

恢复旧版本并验证通过后，仍由操作者决定何时切回云下。发布脚本若后续实现，不应在失败处理或无条件清理逻辑中自动切回云下。

Node 与 Worker 继续分别维护 `origin:`、`worker:` Redis 命名空间。镜像回滚不复制、交换或清空两边的健康状态，也不重置 Analytics Engine 历史数据。

## 云下退出要求

即使已由 Worker 接管，Node 仍需实现基本的优雅退出，确保旧请求和后台任务有机会收尾：

1. 收到 SIGTERM 后，标记 not-ready，停止接受新请求和触发新的定时刷新。
2. 在总退出时限内，等待在途 HTTP 响应传输结束，以及已登记的失败标记、刷新等后台任务完成。
3. 对桑基图剩余队列做一次 best-effort flush，最长等待 2 秒且不能突破总退出时限。
4. 关闭 Redis client，结束进程。

容器启动方式应让终止信号到达 Node。Compose 的 `stop_grace_period` 应比应用总退出时限稍长；总时限到期时允许终止未完成的工作，不承诺任意长请求都能完成。

退出时限只约束进程停止过程，不改变正常请求的超时、尝试顺序、旁路比例或既有 Redis 失败行为。后台任务与调度器适配见 [Node/Hono 部署分析](./node-hono-deployment-analysis.md)，指标收尾约定见 [桑基图数据回传方案](./sankey-analytics-engine-ingestion-plan.md)。

## 参考资料

- [Docker Compose up：容器重建与就绪等待](https://docs.docker.com/reference/cli/docker/compose/up/)
- [Docker Compose stop_grace_period](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)
