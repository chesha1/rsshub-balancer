# Cloudflare 规则

以下规则和相关设置在 Cloudflare zone `virworks.moe` 中手动配置，不随代码部署；修改后同步更新本文。

## WAF 自定义规则

### rsshub-balancer: ingest

动作：Block

```txt
(http.request.uri.path eq "/_internal/metrics/ingest" and not ip.src in $my_servers)
```

ingest 没有应用层鉴权，只允许 `$my_servers`（账户级 IP 列表，保存 Node 服务器的出口 IP）上传指标。

### rsshub-balancer: block scanner paths

动作：Block

```txt
http.host in {"rsshub-balancer.virworks.moe" "rsshub-balancer-origin.virworks.moe"}
and not http.request.uri.path wildcard "/.well-known/*"
and not http.request.uri.path wildcard "/github/file/*"
and not http.request.uri.path wildcard "/rsshub/transform/*"
and (
  http.request.uri.path wildcard "/.*"
  or http.request.uri.path wildcard "/wp-*"
  or http.request.uri.path wildcard "/cgi-bin*"
  or http.request.uri.path wildcard "*/wp-admin/*"
  or http.request.uri.path wildcard "*/wp-includes/*"
  or http.request.uri.path wildcard "*/wp-content/*"
  or http.request.uri.path wildcard "*/.env*"
  or http.request.uri.path wildcard "*/.git/*"
  or http.request.uri.path.extension in {"php" "php5" "php7" "phtml" "asp" "aspx" "jsp" "cgi"}
)
```

在请求进入应用前拦截常见的安全扫描路径。`/.well-known/`、`/github/file/`、`/rsshub/transform/` 下的正常请求也可能带有这些特征，因此排除。

## 重定向规则

### RSSHub 首页规范化

动作：301 重定向到 `https://rsshub-balancer.virworks.moe/`，不保留查询串

```txt
(http.host eq "rsshub-balancer.virworks.moe")
and (
  (http.request.uri.path eq "/" and http.request.uri.query ne "")
  or http.request.uri.path eq "/index.html"
)
```

## 缓存规则

### RSSHub Feed 缓存

设置：允许缓存，Edge TTL 和 Browser TTL 都跟随源站

```txt
(http.host eq "rsshub-balancer.virworks.moe")
and not (
  http.request.uri.path in {
    "/" "/index.html" "/healthz" "/api" "/_internal" "/_assets"
  }
  or starts_with(http.request.uri.path, "/api/")
  or starts_with(http.request.uri.path, "/_internal/")
  or starts_with(http.request.uri.path, "/_assets/")
)
```

zone 开启了 Smart Tiered Cache：各机房的缓存未命中先汇总到靠近源站的上层机房，再由它回源。源站的上层机房由 Cloudflare 按延迟自动选择，不设置云区域提示。

## 配置规则

### rsshub-balancer: disable browser checks

设置：关闭 Browser Integrity Check 和 I'm Under Attack

```txt
http.host in {"rsshub-balancer.virworks.moe" "rsshub-balancer-origin.virworks.moe"}
```

RSS 阅读器本身就是自动化客户端，会被浏览器完整性检查误拦，也无法完成 I'm Under Attack 的质询。配置规则优先于 zone 级设置，即使整个 zone 开启 I'm Under Attack，这两个主机也不受影响。

Bot Fight Mode 同样会质询自动化客户端，但它不经过规则引擎，无法用规则为这两个主机排除，因此 zone 中保持关闭。

## Web Analytics

`rsshub-balancer.virworks.moe` 启用了 Web Analytics 自动注入：Cloudflare 在返回给浏览器的首页 HTML 中插入 `https://static.cloudflareinsights.com/beacon.min.js/...` 脚本，统计数据回传本站 `/cdn-cgi/rum`。

首页 CSP（[apps/web/public/_headers](../apps/web/public/_headers)）为此在 `script-src` 中放行 `https://static.cloudflareinsights.com`，回传请求已包含在 `connect-src 'self'` 中。关闭自动注入后可以移除该来源；改为手动接入时数据发往 `cloudflareinsights.com`，需要在 `connect-src` 中放行该域名。开启其他会向 HTML 注入脚本的功能（如 Rocket Loader、Email Address Obfuscation）前，也要先调整首页 CSP，否则注入的脚本会被浏览器拦截。
