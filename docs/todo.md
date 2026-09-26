# TODO

## 丰富桑基图字段

- [ ] 评估更有展示价值的字段和图表组合。

候选方向：

- HTTP 响应结果、处理耗时档位；当前不采集，若需要展示须重新加入指标。
- Cloudflare 提供的来源网络 ASN、省区或城市等信息。
- 根据 RSSHub 路由映射的内容来源类别，仅记录分类。
- 根据 `User-Agent` 得到的阅读器、浏览器、脚本等客户端粗分类。

后续按信息量、可读性和新增采集成本选择字段，再同步指标协议、聚合查询与前端。当前只记录国家与上游，展示 `country -> upstream`，保留维度复选框和按可见列绘图的逻辑。

## 不再使用的 HTTP 响应体释放

- [ ] 统一消费或取消已经取得但不再使用的 HTTP 响应体。

当前 Workers 代码已有只读取状态码后丢弃 `Response` 的路径，属于现有代码改进，单独安排。

处理范围：

- 上游请求：缓存探测的成功和失败响应、失败后继续尝试其他上游的响应，以及远程实例列表抓取失败的响应。
- 定时健康检查和应用接口：只读取状态码的健康检查，以及 `/api/route/status` 中失败或未被 `Promise.any` 选中的已返回响应。
- 指标查询：查询失败后不再使用的错误响应。

保留当前探测范围、选路顺序和超时策略，不要求提前取消仍在进行的其他探测；正常转发给客户端的响应体继续交由转发链路使用。后续修复优先使用两端可复用的标准 API。

Cloudflare 建议取消不需要的响应体以释放内存；Node/Undici 明确要求消费或取消响应体，避免依赖垃圾回收影响连接复用和连接资源释放。目前确认的是代码缺口，尚无线上资源泄漏或故障的实测结论。

依据：[Cloudflare 响应体取消建议](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections)、[Undici Garbage Collection](https://github.com/nodejs/undici#garbage-collection)。
