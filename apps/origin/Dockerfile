FROM node:26-bookworm-slim AS build
WORKDIR /app
# 使用镜像自带的 npm 安装 pnpm 12，项目依赖与构建仍统一使用 pnpm。
RUN npm install --global pnpm@12
# 先复制依赖清单，让源码变更时仍能复用依赖安装层的缓存。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/origin/package.json apps/origin/package.json
COPY apps/watchdog/package.json apps/watchdog/package.json
COPY apps/edge/package.json apps/edge/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/server-core/package.json packages/server-core/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:origin

FROM node:26-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/apps/origin ./
USER node
EXPOSE 3000
# 运行时使用 --init 或 Compose init: true，让 Node 按默认信号行为退出。
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "index.js"]
