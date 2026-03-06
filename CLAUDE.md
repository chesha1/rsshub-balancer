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

## 常用命令

- `pnpm install` — 安装依赖
- `pnpm run dev` — 启动本地开发服务器
- `pnpm run deploy` — 部署到 Cloudflare Workers
- `pnpm run cf-typegen` — 根据 Worker 配置生成 CloudflareBindings 类型

## 架构

- `src/index.ts` — 主入口，导出 Hono app
- `wrangler.jsonc` — Cloudflare Worker 配置（绑定、KV、R2、D1 等）
- 使用 Cloudflare 绑定时，需传入泛型：`new Hono<{ Bindings: CloudflareBindings }>()`

## Git Commit 规范

使用中文编写 commit message，格式为 `<type>: <description>`，类型包括：

- `feat`: 新功能
- `fix`: 修复 bug
- `refactor`: 重构（不涉及功能变更或 bug 修复）
- `docs`: 文档变更
- `style`: 代码格式调整（不影响逻辑）
- `chore`: 构建、依赖、配置等杂项变更

示例：`feat: 添加健康检查端点`
