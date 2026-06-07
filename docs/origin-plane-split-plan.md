# 云下完整 LB 方案讨论

这只是未来备忘，不是实施计划。

核心动机：Cloudflare Workers CPU time 已经接近可接受上限，需要找一个比继续堆 Worker CPU time 更省钱的办法。这个方向不是为了新增功能，也不是为了把架构做复杂。

## 想法

继续让 Cloudflare Worker 做公开入口，但不购买收费的 Cloudflare Load Balancing。未来如果验证可行，可以把一部分流量转给云下完整 LB。

这里说的是两个完整数据面并存：

- 云上 plane：当前 Worker 继续完整处理 RSSHub LB。
- 云下 plane：用 Go 写一个常驻 RSSHub LB，也完整处理上游选择、缓存探测、失败兜底等能力。

这不是纵向拆分。云下 LB 不只是 Worker 的普通 upstream，也不依赖 Worker 内部状态才能工作。

## 当前倾向

云下 LB 首选 Go + `chi`，保持贴标准库生态：

- `net/http`
- `net/http/httputil.ReverseProxy`
- `chi`
- `log/slog`

选 `chi` 的原因：路由和 middleware 体验比较接近现在 Hono 的用法，同时仍然能自然接 `http.Handler`、标准 middleware 和 `httputil.ReverseProxy`。

`ServeMux` 作为更原生的备选。Gin / Echo / Fiber / Hertz 暂时不作为首选。

## 还没定

- 到底哪些请求适合转给云下。
- 分流规则、比例、fallback 行为。
- 云下部署形态，是否使用 AWS IPv6-only。
- 云下新增成本能不能真的低于 Worker CPU time 成本。
- 云上和云下的日志、指标、成本怎么对比。

## 判断标准

只有在下面几件事成立时，这个方向才值得继续：

- 明显减少 Worker 热路径 CPU time。
- 云下运行成本低于继续消耗 Worker CPU time。
- 延迟、可用性和运维负担可接受。
- 不把项目扩展成通用负载均衡器。

一句话：这是一个用云下 Go LB 分担 Worker CPU time 成本的备选方向，目前还停留在技术选型和可行性讨论阶段。
