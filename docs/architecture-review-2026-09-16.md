**有，而且主要问题是职责分配：一些辅助能力被做成了需要自己维护的基础设施。**

上次我先围绕自写实现补兼容，没有先检查库已有能力，这个审查顺序不对。这次检查了当前 `849a378` 的服务端、前端、状态、日志指标和构建部署，并核对了依赖源码、官方文档及针对性实验。没有修改仓库。

## 一、收益最大的架构调整：Node 是否还需要 Redis？

当前 Redis 只保存：

- 最近一次健康实例列表。
- 某条路径在某个上游的失败标记，有效期 6 小时。

它们都是**可重建的选路辅助信息**。代码已经允许失败标记读取失败时继续请求、写入失败时忽略；当前 Node 又是单进程，Node 和 Worker 的状态本来就完全隔离。

但为此，[redis-node.ts](/home/chesha1/Codes/rsshub-balancer/apps/server/src/adapters/redis-node.ts:29) 维护了 **264 行连接状态机**：建连合并、在途命令、超时、收尾期限、旧连接回调和销毁逻辑。

### 我的建议

**Node 使用成熟、有容量上限的 TTL/LRU 缓存；Worker 保留 Redis。** 过期和淘汰交给 `lru-cache` 等库，不再手写定时清理。[库文档](https://isaacs.github.io/node-lru-cache/)

这能删除整类 Node Redis 连接维护，以及请求路径上的 MGET/SET 网络往返。业务继续调用现有四个状态操作，无需通用工厂。

必须接受的代价是：

- 重启后重新尝试之前失败的节点。
- 启动刷新失败时，只能使用固定 fallback，无法恢复上次列表。
- 缓存满时可能提前淘汰失败标记。
- 将来多个 Node 副本各自维护状态。

**这是我最建议认真考虑的结构性改造。**

如果这些代价不能接受，备用方案是保留 Redis，但把超时策略简化为“超时就销毁整连接”，删除精细收尾状态机。

这里也排除了一个错误捷径：实测发现，当前 Redis SDK 的 AbortSignal/命令 timeout 只约束发送前排队，不能直接替代完整命令截止时间。

## 二、最像 `hono/proxy` 的遗漏：LogTape 已经提供日志格式化

[log.ts](/home/chesha1/Codes/rsshub-balancer/apps/server/src/log.ts:28) 自己实现了：

- Error、cause、AggregateError 的序列化。
- message 拼接。
- JSON 日志结构。
- `errorProps` 转换。

但已安装的 LogTape 就有 `getJsonLinesFormatter()`，支持这些正常错误结构。[官方文档](https://logtape.org/manual/formatters#json-lines-formatter)

**建议直接采用库格式，删除约 70–80 行自写编码逻辑，不增加依赖。**

代价主要是日志字段布局变化，例如 `timestamp` 变为 `@timestamp`、错误字段改为嵌套对象。仓库里没有找到依赖旧布局的机器消费者。

正常错误链已实测；循环错误对象等极端情况仍有局限，必要时保留一个很短的兜底即可，不需要继续维护完整递归序列化器。

## 三、请求生命周期需要统一，不能由选路分支各自收尾

当前 [app.ts](/home/chesha1/Codes/rsshub-balancer/apps/server/src/app.ts:142) 的直接 fallback 提前返回，而请求 ID 透传、最终指标记录主要位于完整选路路径。

于是产生了已经记录在 TODO 中的问题：

- 50% 旁路请求漏记指标。
- 请求 ID 处理不一致。
- 探测和失败响应的正文释放没有统一归属。

**这些问题适合一起从架构上解决。**

建议让 Hono 中间件负责请求 ID、日志上下文、最终日志和一次性指标；选路函数负责选择上游和重试，`proxy` 负责转发。探测函数负责释放自己取得的响应，只返回节点或状态信息。

这样两种选路策略可以继续不同，但都会经过同一套请求收尾。无需引入通用策略框架。[Hono 中间件机制](https://hono.dev/docs/guides/middleware)

补齐旁路统计会改变指标覆盖范围、增加采集量，需要同步统计口径。

## 四、服务发现边界有一个应优先处理的实际风险

我读取的[公开实例目录](https://raw.githubusercontent.com/RSSNext/rsshub-docs/main/.vitepress/theme/components/InstanceList.vue)里，**已经包含 `rsshub-balancer.virworks.moe` 自己**。

当前代码提取所有 URL，然后只做去重和健康检查，没有排除自身。本机调用真实解析函数也确认，自身会进入候选。

健康检查通过后，它可能被选为上游，形成回源自环或递归探测。**尚未查询线上候选列表，不能断言线上已经发生。**

架构上应明确：

> 公开目录提供候选；经过本服务的身份、URL 和能力筛选后，才形成可用于转发的节点列表。

这不需要引入注册中心，但不能继续把展示页面直接当作可信的上游拓扑。

### 另一个较大的选路优化方向

当前正常请求会先探测全部 N 个候选，再请求正文，至少产生 N+1 次外呼。

可以考虑**缓存完整路径对应的最近成功上游提示**，优先尝试它，失效后再探测。缓存的是节点信息，不是 RSS 响应体。

这比直接改成一致性哈希更贴合“复用公共 RSSHub 已有缓存”的目标，但需要先测量探测命中率和耗时。我不会仅凭代码断言一定更快。

## 五、前端也有明确的库替代机会

当前图表静态导入，再手写规则将 ECharts 分成 vendor chunk；实际产物仍会在页面启动时预加载整块图表代码。

建议用 **Vue 异步组件表达图表加载边界，让 Vite 自动分包**。[Vue 文档](https://vuejs.org/guide/components/async)

临时副本构建结果：

| HTML 启动时引用的 JS | 当前 | 异步图表方案 |
|---|---:|---:|
| 同算法 gzip 合计 | 约 245 KB | 约 91 KB |

不增加依赖，可以删除手写 vendor 分类。图表展示时仍需下载其代码，可能多一个加载阶段；这不是线上加载时间测试。

## 哪些“大改”暂时不值得做？

- **不建议直接换 Nginx/通用熔断框架。** 当前缓存感知和按路径失败抑制属于 RSSHub 领域逻辑，普通负载均衡不能自动接管。
- **保留 Nx、Vite、Wrangler 的分工。** 已经由各工具承担合适职责，没有发现值得为之重写构建体系的重复实现。
- **API 契约可以逐步收敛到共享 Zod schema。** 当前只有两个小接口，直接引入完整 Hono RPC 的改造成本偏高。
- **指标链是否删除取决于产品目标。** 如果还要看真实 RSSHub 上游分布，现有 Node→Worker→Analytics Engine 桥接有必要；若改看平台流量和缓存效果，才可以考虑用 GraphQL Analytics 取代整条采集链，但会失去真实上游维度。

## 建议顺序

**先处理候选自引用风险；然后做 LogTape 替代，并决定 Node 是否改为内存状态；接着统一请求生命周期。** 前端异步加载可以独立进行，选路提示缓存则先测量再决定。

完整证据、取舍及被排除的方案已整理到[架构审查报告](/tmp/rsshub-architecture-review-2026-09-16.md)。本轮工作区保持干净。

<oai-mem-citation>
<citation_entries>
MEMORY.md:188-190|note=[Used prior runtime split as context and verified current architecture]
</citation_entries>
<rollout_ids>
01a09664-b686-7192-8ffa-76e6fe8bb9a6
</rollout_ids>
</oai-mem-citation>
