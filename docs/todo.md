# TODO

## 首页桑基图的 WebGL / GPU 绘制

- [ ] 评估将首页桑基图迁移到 AntV G6，利用其 WebGL 渲染器，从 GPU 绘制和几何缓存方向改善性能。

当前使用 ECharts Canvas。国家和路径的长尾分类增多后，节点、曲线和画布高度一起增长；首次绘制和悬停高亮会触发较重的曲线栅格化及画面提交。瓶颈位于浏览器原生绘图链路，其中包含明显的 CPU 处理，不能简单归因于显卡算力不足。

目前通过数据减量改善：国家/地区、一级路径各保留请求量前 30 项，其余合并为“其他”；全部上游与失败结果单独显示，请求总量不变。继续使用曲率 `0.5`，保留渐变、提示框和邻接高亮，并关闭首次展开动画。减少图元和画布规模后，实测卡顿已明显减轻。

后续优先评估 [AntV G6 的 WebGL 渲染路径](https://g6.antv.antgroup.com/manual/further-reading/renderer)，减少反复栅格化和整图重绘，避免继续围绕 ECharts 参数反复调整。迁移前验证桑基图布局、流量宽度、渐变及现有交互的兼容性，并用真实数据比较性能；当前仅记录待办，尚未实施迁移。

## 与本站资源同名的变体路径

- [ ] 让第一段为根目录静态文件名的路径（如 `/favicon.ico/`、`/favicon.ico/x`）也在本地返回 404，不再转发给上游或计入统计。

[utils.ts](../packages/server-core/src/utils.ts) 中的 `isLocalResourcePath()` 按完整路径匹配根目录静态文件，统计的 `path` 却取原始 `pathname` 的第一段（见 [metrics.ts](../packages/server-core/src/metrics.ts) 中的 `getRequestDimensions()`）。`/favicon.ico/`、`/favicon.ico/x`、`/apple-touch-icon.png/x` 这类变体路径不属于本站资源，也不在 Cloudflare 扫描规则的拦截范围内，会进入代理：向候选上游探测缓存并依次转发，失败时写入失败标记；在上游看来，这些无效请求都来自本站的出口地址。它们还会以 `/favicon.ico`、`/apple-touch-icon.png` 计入统计，使公开桑基图出现与本站资源同名的一级路径；[metrics.md](metrics.md) 中“ingest、SQL 查询和首页无需另行过滤静态资源路径”的说法因此并不严格。

2026-10-01 通过 GitHub API 核对，RSSHub `lib/routes` 下有 23 个命名空间带 `.`（如 `dev.to`、`last.fm`），但没有以图片、图标、样式、脚本或字体扩展名结尾的，第一段命中根目录静态文件规则的路径不会是有效订阅。这条规则本来就在代码中，建议直接把根目录静态文件的判断改为只看第一段，与统计的一级路径口径一致；改完后 metrics.md 的上述说法即可成立。实施前需要确认：

- 重新核对 RSSHub 命名空间，确认仍没有以这些扩展名结尾的。不能简单按第一段是否含 `.` 判断，否则会误拦 `dev.to` 这类命名空间。
- 用尾随斜杠、多段路径、大小写和编码字符等边界路径对比新旧规则，确认 `/example/user.png` 这类第一段不是静态文件名的路径仍交给代理。
- 同步修改 `isLocalResourcePath()` 的注释，以及 README、capability-boundary.md 和 metrics.md 中对根目录静态文件的定义。

## 上游版本不一致导致的重定向循环

- [ ] 不同版本的上游对同一组路由给出方向相反的重定向时，入口不再把客户端引入循环；当前的实例是 `/picnob/user/:id` 与 `/picnob.info/user/:id`。

RSSHub 在 2026-03-10（提交 `8637e63`）把 `/picnob` 重定向到 `/picnob.info`，2026-06-06（提交 `055c5b7`，恢复 picnob）又改为把 `/picnob.info` 重定向到 `/picnob`。当前候选上游的行为分别对应这两个版本，2026-10-02 用 `handiworksofficial` 逐个请求上游：

- `rsshub.rssforever.com`、`rsshub.umzzz.com` 把 `/picnob/user/…` 301 到 `/picnob.info/user/…`，自己的 `/picnob.info/user/…` 返回 503；
- `hub.slarker.me`、`rsshub.ktachibana.party`、`rsshub.cups.moe`、`rsshub.99010101.xyz` 把 `/picnob.info/user/…` 301 到 `/picnob/user/…`，自己的 `/picnob/user/…` 返回 503 或超时。

入口把上游的 200–399 响应视为成功并原样转发，重定向交给客户端处理，所以这两个路径只要轮到发出 301 的上游就结束选路，稳定返回 301。`Location` 是相对路径，客户端跟随后回到本站，拿到的是反方向的 301。上游响应带 `Cache-Control: public, max-age=300`，Cloudflare 会缓存这些 301，缓存过期后回源得到的仍是 301。实际上没有任何上游能返回这些订阅的内容，入口本应返回 502，现在却让客户端在两个地址之间来回跳转；进入代理的那部分请求还会记为发出 301 的上游成功。

截至 2026-10-02 的最近 24 小时（Cloudflare 分析数据，按采样估算），两个入口域名共约 36.7 万次访客请求，其中约 27.3 万次是 picnob 路径的 301，约占 74%。这些请求涉及 61 个用户、121 个路径，几乎全部来自同一个 UA（Windows 上的 Edge 138）。约 96% 由 Cloudflare 缓存直接返回，其余约 9500 次缓存过期或未命中，进入代理后照常向候选上游探测缓存并转发。

这不是 picnob 独有的问题：RSSHub 以后再用重定向迁移路由，只要上游版本不一致，就可能出现同样的循环。可以考虑由入口在同一个上游内跟随站内重定向，按最终结果判断该上游是否成功。上面的例子里每个上游最终都会失败，入口返回 502，不再形成循环；只要有上游能返回内容，客户端就能直接拿到。实施前需要确认：

- 只跟随 `Location` 为相对路径或指向该上游自身的重定向，并限制跳转次数；指向外部站点的重定向仍交给客户端。
- 缓存探测、失败标记和指标仍按原始请求路径记录，由跟随后的最终结果决定成功还是失败。
- 304 这类不带 `Location` 的 3xx 响应保持现有处理。
- 同步修改 README 和 capability-boundary.md 中“重定向交给客户端处理”的说明。

当前仅记录待办，尚未实施。
