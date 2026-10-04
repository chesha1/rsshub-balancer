# TODO

## 首页桑基图的 WebGL / GPU 绘制

- [ ] 开发 ECharts 扩展：桑基图连线设为隐藏图形，命中、提示框和高亮由 ECharts 处理，连线画面由插入 ZRender 的 WebGPU 图层绘制。
- [ ] 评估迁移到 AntV G6。**G6 没有桑基图，迁移需要自己多写很多代码**：布局、带状连线、渐变、高亮和提示框效果、尺寸变化时重新布局、Vue 封装都要自己处理；[WebGL 渲染器](https://g6.antv.antgroup.com/manual/further-reading/renderer)下渐变连线无法合批，性能收益也需实测。

## 与本站资源同名的变体路径

- [ ] 让第一段为根目录静态文件名的路径（如 `/favicon.ico/`、`/favicon.ico/x`）也在本地返回 404，不再转发给上游或计入统计。

[utils.ts](../packages/server-core/src/utils.ts) 中的 `isLocalResourcePath()` 按完整路径匹配根目录静态文件，统计的 `path` 却取原始 `pathname` 的第一段（见 [metrics.ts](../packages/server-core/src/metrics.ts) 中的 `getRequestDimensions()`）。`/favicon.ico/`、`/favicon.ico/x`、`/apple-touch-icon.png/x` 这类变体路径不属于本站资源，也不在 Cloudflare 扫描规则的拦截范围内，会进入代理：向候选上游探测缓存并依次转发，失败时写入失败标记；在上游看来，这些无效请求都来自本站的出口地址。它们还会以 `/favicon.ico`、`/apple-touch-icon.png` 计入统计，使公开桑基图出现与本站资源同名的一级路径；[metrics.md](metrics.md) 中“ingest、SQL 查询和首页无需另行过滤静态资源路径”的说法因此并不严格。

2026-10-01 通过 GitHub API 核对，RSSHub `lib/routes` 下有 23 个命名空间带 `.`（如 `dev.to`、`last.fm`），但没有以图片、图标、样式、脚本或字体扩展名结尾的，第一段命中根目录静态文件规则的路径不会是有效订阅。这条规则本来就在代码中，建议直接把根目录静态文件的判断改为只看第一段，与统计的一级路径口径一致；改完后 metrics.md 的上述说法即可成立。实施前需要确认：

- 重新核对 RSSHub 命名空间，确认仍没有以这些扩展名结尾的。不能简单按第一段是否含 `.` 判断，否则会误拦 `dev.to` 这类命名空间。
- 用尾随斜杠、多段路径、大小写和编码字符等边界路径对比新旧规则，确认 `/example/user.png` 这类第一段不是静态文件名的路径仍交给代理。
- 同步修改 `isLocalResourcePath()` 的注释，以及 README、capability-boundary.md 和 metrics.md 中对根目录静态文件的定义。
