FROM node:26.8.2-bookworm-slim AS build
WORKDIR /app
# 直接解包固定版本的 pnpm CLI，依赖安装与构建统一使用 pnpm。
ADD https://registry.npmjs.org/pnpm/-/pnpm-10.33.0.tgz /tmp/pnpm.tgz
RUN mkdir -p /opt/pnpm \
    && tar -xzf /tmp/pnpm.tgz -C /opt/pnpm --strip-components=1 \
    && ln -s /opt/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm \
    && rm /tmp/pnpm.tgz
# 先复制依赖清单，让源码变更时仍能复用依赖安装层的缓存。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/node/package.json apps/node/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/server-core/package.json packages/server-core/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:node

FROM node:26.8.2-bookworm-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/apps/node ./
USER node
EXPOSE 3000
# 运行时使用 --init 或 Compose init: true，让 Node 按默认信号行为退出。
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "node.js"]
