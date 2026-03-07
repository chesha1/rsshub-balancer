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
- **Lint / 格式化**: Biome（单引号，无分号，2 空格缩进）

## 常用命令

- `pnpm install` — 安装依赖
- `pnpm run dev` — 启动本地开发服务器（wrangler dev）
- `pnpm run deploy` — 部署到 Cloudflare Workers
- `pnpm run cf-typegen` — 根据 Worker 配置生成 CloudflareBindings 类型
- `pnpm run lint` — 代码检查（biome check）
- `pnpm run lint:fix` — 代码检查并自动修复

## 架构

- `src/index.ts` — 主入口，导出 Hono app。通配路由 `/*` 处理所有请求
- `src/config.ts` — 上游 RSSHub 实例列表配置
- `wrangler.jsonc` — Cloudflare Worker 配置

### 请求处理流程

1. 并行读取 KV 中所有上游对当前路由的失败记录，将上游分为 healthy / unhealthy 两组，各组内随机洗牌后拼接为优先级队列
2. 并行请求所有上游的 `/api/route/status` 接口，检查是否已缓存当前路由
3. 如果找到已缓存的实例，直接转发请求到该实例
4. 如果所有实例均未缓存，则按优先级队列依次尝试请求，直到某个实例返回成功；失败的实例异步写入 KV 失败记录（TTL 由 `config.failTtl` 控制）
5. 所有实例均失败时返回 502

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
