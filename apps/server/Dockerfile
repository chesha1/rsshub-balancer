FROM node:26.8.2-bookworm-slim AS build
WORKDIR /app
# npm 仅用于安装固定版本的 pnpm，项目依赖与构建统一使用 pnpm。
RUN npm install --global pnpm@10.33.0
# 先复制依赖清单，让源码变更时仍能复用依赖安装层的缓存。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:node

FROM node:26.8.2-bookworm-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/apps/server/node ./
USER node
EXPOSE 3000
# 运行时使用 --init 或 Compose init: true，让 Node 按默认信号行为退出。
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "node.js"]
