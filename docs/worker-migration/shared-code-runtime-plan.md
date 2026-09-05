# Worker 与 Node 的共享代码与运行时适配方案

- 方案状态：代码组织、配套发布原则与 Node Redis 连接生命周期已确认，尚未实施
- 决策日期：2026-09-05
- 适用范围：`apps/server` 的业务代码复用、运行时边界、构建验证与两侧版本管理

## 结论

**保留一个 `apps/server` 包，维护一份共享业务代码，通过 Worker、Node 两个入口和少量平台适配分别运行。**

首次需要整理现有代码中的平台依赖，不能只改配置或增加一行 `serve()`。边界整理完成后，大多数业务功能和修复只需修改一次，再分别构建、验证和部署两端。

复用发生在源码和构建阶段：两个入口直接导入同一份共享模块，各自的构建产物包含这些模块，部署后各自在本地执行业务逻辑。正常 RSS 请求由 Node 处理，共享代码不会额外引入 Worker 调用；已确认的低频指标回传仍按独立链路执行。

日常业务发布默认从同一个 commit 构建 Worker 与 Node 两份产物，作为一次配套发布。两侧可以在发布、验证和回滚期间暂时运行不同版本，但不能因此长期维护两套分叉的业务实现。

## 当前代码的复用基础

当前实现已经具备可继续使用的边界：

- [upstream.ts](../../apps/server/src/upstream.ts) 的 `fetchFromUpstream(request, store, waitUntil)` 通过参数取得状态存储和后台任务能力，选路、缓存探测、转发及 fallback 主体可共享。
- [store.ts](../../apps/server/src/store.ts) 的 `StateStore` 已定义读取实例、更新实例、读取失败标记和记录失败等业务操作。
- [scheduled.ts](../../apps/server/src/scheduled.ts) 的实例抓取与健康检查主体是普通异步流程，可提取为共享刷新函数。
- Hono 路由、普通 middleware、Request ID、结构化日志与大部分标准 Web API 调用可继续复用。

主要耦合集中在 [index.ts](../../apps/server/src/index.ts)、[types.ts](../../apps/server/src/types.ts)、[metrics.ts](../../apps/server/src/metrics.ts) 以及存储实现：应用直接依赖 `CloudflareBindings`、`c.executionCtx`、Analytics Engine binding 和 `request.cf`，Redis 连接也采用当前 Worker 的生命周期。

实施时沿着这些现有边界整理，不重写选路算法。完整运行时差异见 [Node/Hono 部署分析](./node-hono-deployment-analysis.md)。

## 代码组织

建议先在现有包内形成下列结构。文件名与拆分粒度可在实施时调整，这里约定职责边界，不要求一次建齐所有目录。

```text
apps/server/src/
├── app.ts                 共享 Hono 路由和请求处理流程
├── upstream.ts            共享选路、探测、转发逻辑
├── refresh-instances.ts   共享实例刷新逻辑
├── runtime.ts             应用需要的少量接口
├── metrics-event.ts       共享指标事件、协议定义和校验
├── worker.ts              Worker 入口与依赖组装
├── node.ts                Node 入口与依赖组装
└── adapters/              存储、指标、后台任务等具体实现
```

`app.ts` 提供应用工厂，共享路由只使用显式提供的配置、服务与请求上下文。两个入口负责组装平台能力，公共算法只依赖所需接口；共享模块不反向导入入口或具体平台适配。

Worker 入口导出 HTTP `fetch` 与 `scheduled` handler，并把 bindings 和当前请求的执行上下文转换成应用依赖。Node 入口通过 `@hono/node-server` 启动服务，负责配置加载、进程级资源、定时器和退出收尾。[Hono Workers 文档](https://hono.dev/docs/getting-started/cloudflare-workers#using-hono-with-other-event-handlers)、[Hono Node 文档](https://hono.dev/docs/getting-started/nodejs)

平台专属接口在各自入口挂载：指标 ingest 和首页桑基图查询按既定方案留在 Worker；Node 的就绪状态与进程生命周期接口由 Node 组装。公共 RSS 路由及两端都需要的业务接口复用同一实现。2026-09-06 补充的共享 `GET /api/upstreams` 使用当前运行时的 `getUpstreams()`，使首页列表随 RSS 承接环境切换；旧 `/_internal/upstreams` 在 Worker 中过渡重定向至新地址，完整契约见 [首页当前上游实例列表](./frontend-worker-failover-plan.md#首页当前上游实例列表随承接环境切换)。组装时保留具体接口优先于 `/api/*` 404 和 RSS catch-all 的顺序。

当前保持一个仓库、一个 server 包和一条开发主线。没有必要增加两个长期平台分支、独立的共享库版本、内部包发布流程或通用依赖注入容器。只有未来出现多个独立应用需要消费这些模块时，再评估提取 workspace package。

## 共享规则、配置与平台实现

| 能力 | 共享部分 | Worker 适配 | Node 适配 |
| --- | --- | --- | --- |
| HTTP 请求 | Hono 路由、请求处理和选路流程 | module `fetch` | Node HTTP adapter |
| 状态存储 | `StateStore`、数据格式、TTL 与 key 构造规则 | 现有 Redis/Redis HTTP 或 KV 适配，使用 `worker:` | Redis/Redis HTTP，使用 `origin:`；直连 Redis 适配进程内连接复用 |
| 后台任务 | 提交任务的回调及现有业务错误处理 | 当前请求的 `ctx.waitUntil` | 跟踪任务、处理异常并在退出时收尾 |
| 请求指标 | 记录时机、事件字段和协议校验 | 通过 binding 直接写 Analytics Engine | 本地有界 buffer，批量提交现有 Worker ingest |
| 请求位置 | 规范化后的 country、colo 等元信息 | 从原始 `request.cf` 提取 | 从原始请求的可信 Cloudflare headers 提取 |
| 实例刷新 | 抓取、健康检查、更新列表和失败时保留旧列表 | Cron Trigger 调用共享函数 | 防重入定时器调用同一函数 |
| 配置注入 | 业务配置结构、默认规则与校验逻辑 | 从 bindings 组装 | 启动时读取并校验环境变量 |
| 静态资源与缓存 | 已确认的路由与[轻量缓存原则](./zone-cache-plan.md#轻量缓存原则)，允许两端缓存行为不同 | 前端 Static Assets、现有 Workers Cache | 不部署前端；普通 RSS 使用 Zone Cache，不新增应用响应缓存 |

业务配置和失败语义继续沿用已确认的迁移基线，包括现有单次超时、尝试顺序、fallback 比例与状态读取失败处理。Redis 地址、端口和凭据等部署值由各自入口提供；状态命名空间由运行时适配固定选择。

配置可以选择实现，但不能代替实现。Node 的直连 Redis adapter 负责进程内 client 复用、并发建连协调、失效连接清理与后续操作重建，以及单条命令超时后的取消或有界收尾；不能照搬当前每条命令结束后销毁连接的逻辑。正常完成保留连接，连接失效时允许同一连接上的在途命令失败，恢复连接不重放旧命令。具体边界与验收见 [Node 部署分析：Redis 连接生命周期](./node-hono-deployment-analysis.md#redis-连接生命周期)及其验证清单；这些逻辑集中在连接适配层，`StateStore` 和共享选路代码继续沿用原有失败处理。

### 依赖的生命周期

- Worker 的 `ctx` 属于当前请求或事件，后台任务回调必须绑定当前上下文，不能保存在全局供后续请求复用。
- Node 的 Redis client、指标 buffer、后台任务管理和定时器按进程管理，请求阶段复用；退出时按 [云下发布方案](./origin-release-plan.md#云下退出要求)收尾。
- 共享实例刷新代码分别读取、写入两端自己的状态命名空间。共享代码不意味着共用健康结果或把一边的内存缓存复制给另一边。

### 指标协议与平台字段

共享模块维护业务事件类型、上传协议版本和运行时校验规则。TypeScript 类型不能替代 HTTP 边界上的实际校验；Worker ingest 仍须先校验完整批次，再写入数据。

业务指标生成保留完整选路路径的现有记录位置；前置 `DIRECT_FALLBACK_RATE` 分支继续不记录，漏记修复已另列 [TODO](../todo.md#前置-fallback-请求的桑基图漏记)，不随本次迁移处理。Node 仅缓冲已生成的业务事件，不在 RSS 请求中等待网络上传；Worker 直接写入及 ingest 写入共用 Analytics Engine 字段映射，`layer`、`plane` 等可信字段由 Worker 对应入口确定。数据集、字段、地域来源、整批校验和 at-most-once 语义均以 [桑基图数据回传方案](./sankey-analytics-engine-ingestion-plan.md)为准。

Node 的 colo 不能仅因字段名相同就视作 Worker ingress colo；继续遵守既定 `CF-Ray` 来源说明或 `unknown` 处理，不使用指标上传请求的位置覆盖原始请求信息。

### 控制抽象范围

只为真实的平台差异建立接口。普通 `fetch`、`Request`、`Response`、`URL` 和算法不必逐个包装；已经能在两端使用的日志实现也不必复制。

如果一个运行差异可以用标准 API 在共享代码中修正，应优先修一次供两端使用。具体修正保留既定业务行为，不借迁移增加新的重试、可用性或持久化保证。

本方案确定上述工作的代码归属，Node Redis 连接生命周期及对应验收已按上述链接确认为迁移适配要求。其余临时评审项仍逐项讨论，刷新总时限等其他事项及其验收方法不因本文落盘而自动确认为实施要求。

## 构建与验证

两端使用同一仓库的 pnpm 锁文件与共享源码，但分别构建：

- Worker 从 `worker.ts` 经 Wrangler 构建，并包含现有前端产物。
- Node 从 `node.ts` 构建为可执行 Node 产物，再构建后端镜像；不把 Wrangler dry-run 产物当作 Node 程序。
- 两个目标使用独立输出目录，避免相互覆盖；服务器 Compose 与反代配置继续维护在 `my-servers`，应用和镜像构建定义留在本仓库。
- 两端分别执行类型检查。共享应用类型不再绑定全局 `CloudflareBindings`；Node 检查范围不依赖 Worker 生成类型来掩盖缺失的平台能力。具体平台依赖只从对应入口进入构建图。

共享业务测试维护一份，验证选路、失败标记、fallback 和指标生成等业务契约。实际运行时还需分别验证 GET/HEAD、状态码、响应头、压缩和流式响应，以及后台任务、存储连接、定时刷新和 Node 退出行为。

同一份源码不保证运行时行为完全相同。Node 验证通过不能替代 Worker 接管验证，反之亦然。检查范围按改动选择，完整迁移验收沿用 [Node/Hono 部署分析](./node-hono-deployment-analysis.md#验证清单)和 [迁移操作手册](./migration-failover-runbook.md)。

## 配套发布与回滚原则

### 默认从同一 commit 构建两份产物

公共业务改动作为一次配套发布管理：修改共享代码，验证两种运行时，从同一 commit 构建 Worker 和 Node 产物，再分别部署并核对实际版本。备用 Worker 也应取得公共业务修复，避免 Node 已修复的问题在接管时重新出现。

配套发布不要求两个部署原子完成。发布、验证、回滚期间允许新旧版本并存；仅影响 Node 或 Worker 适配层的修复，也可以单侧发布，但要记录实际版本组合并确认业务、指标协议及备用端能力仍兼容。

一份发布记录应包含：

- 目标发布的源码 commit，以及两侧实际运行的源码版本。
- Worker 部署版本、Node 镜像 digest 和对应配置版本。
- Node 发送的指标 schema、Worker 接收端支持的 schema，以及凭据版本标识；不记录凭证明文。
- 已验证可共同运行的版本组合、Worker 接管验证结果和可恢复的上一组产物与配置。

Worker 版本与 Node digest 是不同的产物标识，即使源码 commit 相同也要分别记录。回滚复用保留的产物，不临时从旧源码重新构建来代替已验证版本。

### 协议升级与回滚保持兼容

如果指标协议需要升级，先部署能够接受新旧发送格式的 Worker 接收端，再更新 Node 发送端。在允许 Node 回滚到旧版本期间，保留对应接收兼容能力；首版支持的 schema 仍以桑基图方案为准，这里约定后续升级方式。

需要把接收端回滚到不支持新格式的版本时，应先把 Node 恢复到兼容的发送版本，或使用仍兼容新格式的 Worker 修复版本。凭据变更也需核对回滚后的发送与接收配置，不能只看应用 commit。

继续沿用既定的云下发布顺序：先确认 Worker 接管，再更新和直接验证 Node，最后由操作者切回。每次进入该流程前，确认计划承担接管的 Worker 版本已经过验证，并与当时的 Node 指标发送端兼容；共享源码本身不能代替这项确认。

本文补充代码与版本配套原则。流量切换、Compose 更新、失败处理和退出步骤仍以 [云下发布方案](./origin-release-plan.md)为准；具体发布涉及的新旧版本组合在实施时填写并验证。

## 实施顺序

1. 从现有入口提取共享 app、最小依赖接口和实例刷新函数，保留 Worker 原有业务行为。
2. 接入 Worker 适配并验证原有路径，再新增 Node 入口、配置加载和运行时适配；两端始终使用同一份公共业务代码。
3. 按既定方案完成状态隔离、指标回传、缓存与进程生命周期适配，分别验证两端；首次迁移不依赖后置的探活 Worker 或切换 Actions。
4. 增加两端构建与类型检查目标，记录配套产物和兼容版本，按既定手动流程验证接管、云下发布与恢复。

后续一般业务修复沿用“改一份共享逻辑、验证两个运行时、构建两份产物、分别发布”的流程。无需同步复制代码或把一端的业务补丁手工移植到另一端。
