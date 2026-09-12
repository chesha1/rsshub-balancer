# TODO

## 丰富桑基图字段

- [ ] 评估更有展示价值的字段和图表组合。

候选方向：

- 已有指标中的 HTTP 响应结果、处理耗时档位；可评估用响应结果替换目前基本固定的处理方式。
- Cloudflare 提供的来源网络 ASN、省区或城市等信息。
- 根据 RSSHub 路由映射的内容来源类别，仅记录分类。
- 根据 `User-Agent` 得到的阅读器、浏览器、脚本等客户端粗分类。

后续按信息量、可读性和新增采集成本选择字段，再同步指标协议、聚合查询与前端。当前方案先移除机房维度，展示 `country -> outcome -> upstream`，见 [桑基图方案](./worker-migration/sankey-analytics-engine-ingestion-plan.md#查询与前端)。

## 前置 fallback 请求的桑基图漏记

- [ ] 补记 `DIRECT_FALLBACK_RATE` 前置直转分支的请求指标。

2026-09-06 已确认：本次云上云下迁移保留此既有缺陷，修复另行安排，不作为迁移的实施或验收要求。

当前 [公开代理入口](../apps/server/src/index.ts) 的前置直转分支在 `recordRouteRequestMetric()` 之前返回，成功和失败请求均未进入桑基图。完整选路内部的 fallback 和重试仍会走现有指标记录位置，不属于这项漏记。

后续修复时，在共享业务层为前置分支的成功、上游错误响应和异常返回补齐指标，每个请求只生成一个事件；沿用 Node 批量回传与 Worker 直接写入的各自提交方式，避免与完整选路路径重复记录。届时同步更新统计口径、费用估算及验证，不改变旁路比例、选路顺序和业务响应。

迁移期间的统计边界见 [桑基图数据回传方案](./worker-migration/sankey-analytics-engine-ingestion-plan.md#指标口径)。

## 不再使用的 HTTP 响应体释放

- [ ] 统一消费或取消已经取得但不再使用的 HTTP 响应体。

当前 Workers 代码已有只读取状态码后丢弃 `Response` 的路径，属于现有代码改进，单独安排，不作为本次云上云下迁移的实施或验收要求。

处理范围：

- [上游请求](../apps/server/src/upstream.ts)：缓存探测的成功和失败响应、失败后继续尝试其他上游的响应，以及远程实例列表抓取失败的响应。
- [定时健康检查](../apps/server/src/scheduled.ts)和[应用接口](../apps/server/src/index.ts)：只读取状态码的健康检查，以及 `/api/route/status` 中失败或未被 `Promise.any` 选中的已返回响应。
- [指标查询](../apps/server/src/routes/internal.ts)：查询失败后不再使用的错误响应。

保留当前探测范围、选路顺序和超时策略，不要求提前取消仍在进行的其他探测；正常转发给客户端的响应体继续交由转发链路使用。后续修复优先使用两端可复用的标准 API。

Cloudflare 建议取消不需要的响应体以释放内存；Node/Undici 明确要求消费或取消响应体，避免依赖垃圾回收影响连接复用和连接资源释放。目前确认的是代码缺口，尚无线上资源泄漏或故障的实测结论。

依据：[Cloudflare 响应体取消建议](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections)、[Undici Garbage Collection](https://github.com/nodejs/undici#garbage-collection)。
