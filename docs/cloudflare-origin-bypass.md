# Cloudflare 路径级云下直连方案

本文档总结一次关于 `rsshub-balancer.virworks.moe` 路径级分流的讨论。目标是让一部分请求完全绕过 Cloudflare Worker，直接回到云下 RSSHub 实例，从而减少 Worker CPU time，同时尽量保持现有公开域名不变。

## 目标

当前域名仍然使用：

```txt
https://rsshub-balancer.virworks.moe
```

最终期望：

- `/bilibili/*` 直接走云下 RSSHub，不进入 Worker。
- 其它路径继续进入 `rsshub-balancer` Worker。
- 不购买 Cloudflare Load Balancing。
- 不新增公开 DNS-only 源站别名，避免主动暴露源站 IP。

## 最终链路

`/bilibili/*` 的请求链路：

```txt
用户
  -> Cloudflare
  -> 源站 IP:443
  -> Traefik
  -> RSSHub container:1200
```

其它路径的请求链路：

```txt
用户
  -> Cloudflare
  -> rsshub-balancer Worker
  -> Worker 内部继续按现有逻辑选择上游
```

## Cloudflare 配置

`virworks.moe` zone 中需要有一条橙云 DNS 记录：

```txt
Type: A
Name: rsshub-balancer
IPv4: <origin-ip>
Proxy status: Proxied
TTL: Auto
```

不要新增类似下面这种公开 DNS-only 源站别名：

```txt
origin-rsshub.example.com A <origin-ip> DNS only
```

如果要保持源站 IP 不主动出现在公开 DNS 响应里，公开业务域名应继续使用橙云代理。

Worker 绑定需要从 Custom Domain 切换为 Workers Routes：

```txt
rsshub-balancer.virworks.moe/*           -> Worker rsshub-balancer
rsshub-balancer.virworks.moe/bilibili/*  -> None / no script
```

更具体的 `/bilibili/*` route 会绕过 Worker。剩下路径命中 `/*` route，继续由 Worker 处理。

## Wrangler 配置

`apps/server/wrangler.jsonc` 不再声明 `routes`。原因是 `wrangler.jsonc` 只能表达“当前 Worker 绑定到哪些 route”，不能表达 `None / no script` route。

如果保留 `routes`，后续 `pnpm deploy` 可能把 Cloudflare Dashboard 或 API 中配置的 Workers Routes 覆盖掉。因此 route 的来源应放在 Cloudflare Dashboard、Cloudflare API 脚本或 Terraform 等 zone 级配置里。

保留：

```jsonc
"workers_dev": false
```

## 云下 Traefik 配置

云下 RSSHub 在 `my-servers` 仓库的 `rsshub.yml` 中通过 Traefik labels 暴露。关键配置是：

```yaml
- traefik.http.routers.rsshub.rule=Host(`<existing-rsshub-host>`) || Host(`rsshub-balancer.virworks.moe`)
- traefik.http.routers.rsshub.entrypoints=websecure
- traefik.http.routers.rsshub.tls=true
- traefik.http.services.rsshub.loadbalancer.server.port=1200
- traefik.docker.network=traefik
```

Traefik 根据请求的 `Host: rsshub-balancer.virworks.moe` 匹配到 `rsshub` router，再转发到 RSSHub 容器的 `1200` 端口。

请求 path 会原样传给 RSSHub。当前没有配置 `StripPrefix` 或 `ReplacePath`，因此：

```txt
/bilibili/user/video/2267573
```

到 RSSHub 时仍然是同一个 path。

## TLS 证书

云下 Traefik 使用 Cloudflare Origin CA 证书。`my-servers` 中已经按域名拆分证书：

```txt
certs/<existing-origin-domain>.pem
certs/<existing-origin-domain>-key.pem
certs/virworks.moe.pem
certs/virworks.moe-key.pem
```

`traefik-dynamic.yml` 同时加载这两组证书。`virworks.moe.pem` 需要覆盖 `*.virworks.moe` 或至少覆盖 `rsshub-balancer.virworks.moe`。

Cloudflare SSL/TLS 模式应保持：

```txt
Full (strict)
```

## 尽量不中断的切换顺序

推荐按下面顺序操作：

1. 先同步云下 RSSHub compose，确认 Traefik 已经接受 `rsshub-balancer.virworks.moe`。
2. 先在 Cloudflare 添加 `rsshub-balancer.virworks.moe/* -> Worker rsshub-balancer`。
3. 删除 Worker Custom Domain `rsshub-balancer.virworks.moe`。
4. 添加或确认橙云 DNS A 记录 `rsshub-balancer -> <origin-ip>`。
5. 验证普通路径仍然进入 Worker。
6. 最后添加 `rsshub-balancer.virworks.moe/bilibili/* -> None / no script`。
7. 验证 `/bilibili/*` 不再进入 Worker，并且云下 RSSHub 能正常响应。

如果 `/bilibili/*` 出问题，最快回滚方式是删除 no-script route。删除后请求会重新命中 `rsshub-balancer.virworks.moe/* -> Worker rsshub-balancer`。


## 当前结论

这次方案选择的是 Cloudflare 原生路由分流：

- 由 Cloudflare Workers Routes 做路径级分流。
- 由 no-script route 让 `/bilibili/*` 完全不进入 Worker。
- 由 Traefik 根据 Host 把请求转给云下 RSSHub。
- `wrangler.jsonc` 不再管理 route，避免部署时覆盖 zone 级 no-script 配置。
