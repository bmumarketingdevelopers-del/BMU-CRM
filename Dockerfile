# syntax=docker/dockerfile:1
# One image for every BMU Hub backend process and the website. docker-compose.prod.yml runs it four ways:
#   migrate  apps/api: prisma migrate deploy + seed (runs once, then exits)
#   api      apps/api: node dist/main.js    (PROCESS_ROLE=api,    port 4000)
#   worker   apps/api: node dist/worker.js  (PROCESS_ROLE=worker, health port 4001)
#   web      apps/web: next start           (port 3000; forwards /api to the api service)
# Build: docker build -t bmu-hub .   (API_URL is baked into the website at build time; default http://api:4000)

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS build
COPY . .
# Only the API, the website and what they share (the phone app is built separately with Expo).
RUN pnpm install --frozen-lockfile --filter "@bmu/api..." --filter "@bmu/web..."
ARG API_URL=http://api:4000
ENV API_URL=$API_URL
RUN pnpm --filter @bmu/shared build && pnpm --filter @bmu/api build && pnpm --filter @bmu/web build

FROM base AS runtime
ENV NODE_ENV=production STORAGE_DIR=/data/storage
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 3000 4000 4001
WORKDIR /app/apps/api
CMD ["node", "dist/main.js"]
