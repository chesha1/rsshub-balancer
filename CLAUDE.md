# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

RSSHub Balancer —— 为多个 RSSHub 实例做负载均衡，复用缓存响应，减少重复抓取。部署为 Cloudflare Worker。

## 技术栈

- **运行时**: Cloudflare Workers
- **Web 框架**: Hono
- **语言**: TypeScript（ESNext，Bundler 模块解析）
- **包管理器**: pnpm
- **部署工具**: Wrangler
- **Lint / 格式化**: Biome（单引号，按需分号，2 空格缩进，注释统一用 `//` 不用 `/* */`）

## 开发环境

- **Shell**: fish（不支持 bash 语法如 `$()`、`for ... do ... done`，执行 bash 脚本时需用 `bash -c '...'`）

## 常用命令

- `pnpm install` — 安装依赖
- `pnpm run dev` — 启动本地开发服务器（wrangler dev）
- `pnpm run deploy` — 部署到 Cloudflare Workers
- `pnpm run cf-typegen` — 根据 Worker 配置生成 CloudflareBindings 类型
- `pnpm run lint` — 代码检查（biome check）
- `pnpm run lint:fix` — 代码检查并自动修复
- `pnpm exec tsc --noEmit` — TypeScript 类型检查（修改代码后需同时通过 lint 和 tsc）

## 架构

- `src/index.ts` — 主入口，导出 Hono app 及 `RequestCoalescer` DO class。通配路由 `/*` 处理所有请求
- `src/coalescer.ts` — `RequestCoalescer` Durable Object，跨 isolate 的请求合并层
- `src/upstream.ts` — 上游选择与请求转发逻辑（缓存检查、健康分组、顺序回退）
- `src/types.ts` — 共享类型定义（`ResponseSnapshot`）
- `src/config.ts` — 上游 RSSHub 实例列表及 `failTtl` 等参数
- `src/utils.ts` — 共享工具函数（`trimSlash`、`shuffle`、`fromResponse`、`toResponse`）
- `wrangler.jsonc` — Cloudflare Worker 配置，KV 绑定名为 `KV`，Durable Object 绑定名为 `DO`（通过 `env.KV`、`env.DO` 访问）

> 项目当前没有测试框架，也没有测试用例。

### 请求处理流程

幂等请求（GET/HEAD）经过两级请求合并（request coalescing），非幂等请求直接走上游解析：

1. **isolate 级合并**（`src/index.ts`）：同一 isolate 内对同一 requestPath 的并发请求共享同一个 promise
2. **Durable Object 级合并**（`src/coalescer.ts`）：跨 isolate 的同路径并发请求在 DO 内合并
3. **上游解析**（`src/upstream.ts`）：
   - 并行读取 KV 中所有上游对当前路由的失败记录，将上游分为 healthy / unhealthy 两组，各组内随机洗牌后拼接为优先级队列
   - 并行请求所有上游的 `/api/route/status` 接口，检查是否已缓存当前路由
   - 如果找到已缓存的实例，将其提到队首优先尝试
   - 按队列依次请求直到某个实例返回成功（2xx/3xx）；失败的实例异步写入 KV 失败记录（TTL 由 `config.failTtl` 控制）
   - 所有实例均失败时返回 502

`ResponseSnapshot`（`src/types.ts`）将 Response 的 body 缓冲为 `Uint8Array`，使单次 fetch 结果可被多个 follower 复用。

### 注意事项

- 使用 Cloudflare 绑定时，需传入泛型：`new Hono<{ Bindings: CloudflareBindings }>()`
- `worker-configuration.d.ts` 由 `cf-typegen` 自动生成，已从 Biome 检查中排除

## Git Commit 规范

使用中文编写 commit message，格式为 `<type>: <description>`，类型包括：

- `feat`: 新功能
- `fix`: 修复 bug
- `refactor`: 重构（不涉及功能变更或 bug 修复）
- `docs`: 文档变更
- `style`: 代码格式调整（不影响逻辑）
- `chore`: 构建、依赖、配置等杂项变更

示例：`feat: 添加健康检查端点`
