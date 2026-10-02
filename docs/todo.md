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
