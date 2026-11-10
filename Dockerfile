# syntax=docker/dockerfile:1.7
# Image production cho Dezon Omni-Inbox (một Dockerfile, nhiều target):
#   docker build --target api    -t dezon-inbox-api:latest .
#   docker build --target worker -t dezon-inbox-worker:latest .
#   docker build --target web    -t dezon-inbox-web:latest --build-arg NEXT_PUBLIC_API_URL=https://alo.vuathau.com.vn/api .
# Migration chạy bằng image api: node node_modules/@dezon/db/dist/scripts/migrate.js
# (docker-compose.prod.yml có service one-shot `migrate`).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- base: Node + pnpm (đúng bản trong package.json#packageManager) ----------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

# ---------- deps: cài toàn bộ dependency của workspace (cache theo lockfile) ----------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,id=dezon-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ---------- build-server: shared -> db -> core -> api + worker, rồi tách bản prod ----------
FROM deps AS build-server
ARG NODE_BUILD_MEMORY_MB=2048
ENV NODE_OPTIONS=--max-old-space-size=${NODE_BUILD_MEMORY_MB}
COPY . .
# `pnpm -r` chạy theo thứ tự phụ thuộc (workspace package build trước app).
RUN pnpm --filter "@dezon/api..." --filter "@dezon/worker..." run build
# `pnpm deploy`: thư mục độc lập chỉ có dependency production (workspace package copy theo "files").
# Copy lại dist của app cho chắc (app không khai báo "files").
RUN --mount=type=cache,id=dezon-pnpm-store,target=/pnpm/store \
    pnpm --filter @dezon/api deploy --prod /out/api && \
    pnpm --filter @dezon/worker deploy --prod /out/worker && \
    rm -rf /out/api/dist /out/worker/dist && \
    cp -r apps/api/dist /out/api/dist && \
    cp -r apps/worker/dist /out/worker/dist && \
    rm -rf /out/api/src /out/api/test /out/worker/src /out/worker/test && \
    test -f /out/api/node_modules/@dezon/db/dist/scripts/migrate.js && \
    test -d /out/api/node_modules/@dezon/db/drizzle

# ---------- build-web: Next.js standalone (NEXT_PUBLIC_API_URL được inline lúc build) ----------
FROM deps AS build-web
ARG NEXT_PUBLIC_API_URL
ARG NODE_BUILD_MEMORY_MB=2048
RUN test -n "$NEXT_PUBLIC_API_URL" || (echo "Thiếu build-arg NEXT_PUBLIC_API_URL" >&2 && exit 1)
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NODE_OPTIONS=--max-old-space-size=${NODE_BUILD_MEMORY_MB}
COPY . .
RUN pnpm --filter "@dezon/web..." run build && mkdir -p apps/web/public

# ---------- runtime chung ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    TZ=Asia/Ho_Chi_Minh
WORKDIR /app

# ---------- target: api (kiêm chạy migration/seed) ----------
FROM runtime AS api
COPY --from=build-server --chown=node:node /out/api ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

# ---------- target: worker ----------
FROM runtime AS worker
COPY --from=build-server --chown=node:node /out/worker ./
USER node
CMD ["node", "dist/main.js"]

# ---------- target: web ----------
FROM runtime AS web
ENV PORT=3100 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=build-web --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build-web --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build-web --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3100/login').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
