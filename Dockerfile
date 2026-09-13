FROM node:24-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl sqlite3 \
    && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /app
# better-sqlite3 has no prebuilt binary for this Node/ABI combo, so the deps
# stage needs a minimal toolchain to compile it. The runtime stage does not.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# pnpm-workspace.yaml carries the catalogs referenced by the lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && ./node_modules/.bin/vp build

FROM base AS runtime
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
ENV PORT=3000 \
    NODE_ENV=production \
    DATABASE_PATH=/data/thread-artifacts.db \
    EXCERPT_DB_PATH=/data/excerpts.db \
    QUOTA_DB_PATH=/data/provider-quota.db
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -sf "http://localhost:${PORT:-3000}/api/health" || exit 1
CMD ["sh", "-c", "node node_modules/srvx/bin/srvx.mjs serve --prod --port ${PORT:-3000} --entry dist/server/server.js --static ../client"]
