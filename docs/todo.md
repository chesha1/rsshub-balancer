# TODO

## Redis 切换后的 EventEmitter timeout listener 告警

- 状态：待排查，当前先记录观察项。
- 首次记录日期：2026-05-05
- 相关日志：
  - `Possible EventEmitter memory leak detected. 11 timeout listeners added to an EventEmitter. Use emitter.setMaxListeners() to increase limit`
  - 日志来源通常出现在 `RequestCoalescer` Durable Object 的 `coalesce` RPC 链路中。

### 已观察到的现象

- 状态存储从 Cloudflare KV 切换到外部 Redis / Valkey 后，开始频繁出现上述 Node `EventEmitter` listener 数量告警。
- 日志中的 Worker outcome 仍为 `ok`，目前未观察到请求结果因此失败。
- 日志模板里的 `Use <DOMAIN>() to increase limit` 是 Cloudflare 对 `emitter.setMaxListeners()` 的模板归一化结果，不是需要调用的业务函数。

### 当前判断

- 该告警更可能来自 `@redis/client` 在 `nodejs_compat` 环境下使用 Node socket / EventEmitter 的内部实现，而不是 `RequestCoalescer` 的 `inflight` 合并 Map 泄漏。
- 当前代码里 Redis 连接和命令都有较短超时；如果外部 Redis 偶发慢连接或慢命令，可能触发命令超时、销毁共享 client、后续请求重新建连，从而在高并发下放大 timeout listener 告警。
- 目前判断该现象主要是运行时告警噪音，不直接影响响应结果，但如果频率继续升高，需要确认是否存在 Redis 连接抖动或重连风暴。

### 后续排查方向

- 按 [Redis timeout 根因定位方案](./redis-timeout-root-cause-plan.md) 拆分 connect、command、client lifecycle 和 runtime warning 日志，先确认底层原因。
- 捕获 `process.on('warning')`，临时记录 `MaxListenersExceededWarning` 的 `stack`、`emitter.constructor.name`、`type`、`count`，确认栈是否指向 `@redis/client/dist/lib/client/socket.js`。
- 给 Redis 客户端补充临时生命周期日志，包括 connect start / ok / failed、command start / ok / failed / timeout、client destroy，并带上 operation、durationMs、inflight 计数和 requestId。
- 对照 Redis / Valkey 服务端指标，重点查看连接数波动、连接拒绝数、慢日志、命令延迟和网络延迟。
- 做 Redis / KV A/B 或临时提高 Redis `connectTimeout`，验证告警频率是否随外部 Redis 路径变化。
- 在确认 listener 有界且会被清理之前，不直接使用 `setMaxListeners()` 压掉告警。

# 其他

- [x] 多写一个 label，统计各 upstream 的请求占比
- [ ] 解决 get instances 超时问题，先按 [instances stale cache 方案](./instances-stale-cache-plan.md) 收敛请求热路径风险
- [ ] 减少对 DO 的使用
- [ ] 实现前端页面
