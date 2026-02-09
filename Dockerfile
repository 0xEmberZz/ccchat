FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# 安装依赖
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/hub/package.json packages/hub/
RUN pnpm install --frozen-lockfile --prod=false

# 复制源码并构建
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/hub/ packages/hub/
RUN pnpm --filter @ccchat/shared build && pnpm --filter @ccchat/hub build

# 生产阶段
FROM node:20-slim AS runner
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY --from=base /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=base /app/packages/shared/package.json packages/shared/
COPY --from=base /app/packages/shared/dist packages/shared/dist/
COPY --from=base /app/packages/hub/package.json packages/hub/
COPY --from=base /app/packages/hub/dist packages/hub/dist/

RUN pnpm install --frozen-lockfile --prod

EXPOSE ${PORT:-9900}
CMD ["node", "packages/hub/dist/index.js"]
