# Lookahead command center (D-93). Multi-stage: deps -> build -> runtime.
# Build from the repo root:  docker build -t lookahead .
# Run:                       docker run -p 3000:3000 --env-file .env lookahead
# The runtime image carries only what `next start` needs plus data/raw (the
# reference package) and the repo-root layout that outputFileTracingRoot
# expects. No AWS keys are baked in; the SDK reads them from the environment
# or an instance/task role, and every AWS feature degrades to the local path.

ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.28.0

# ---------------------------------------------------------------- deps
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/engine/package.json packages/engine/package.json
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json tsconfig.json ./
COPY packages/engine packages/engine
COPY apps/web apps/web
COPY data/raw data/raw
ENV NEXT_TELEMETRY_DISABLED=1
# LOOKAHEAD_EMBED_ORIGINS at build time is baked into next.config headers();
# src/middleware.ts re-applies the /embed policy from the runtime environment.
RUN pnpm --filter web build

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ARG PNPM_VERSION
RUN apk add --no-cache curl \
 && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && addgroup -S lookahead && adduser -S -G lookahead -h /home/lookahead lookahead
WORKDIR /repo
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 \
    LOOKAHEAD_LIVE_DIR=/var/lib/lookahead/live
# Workspace manifests + node_modules (the engine ships TypeScript source that Next transpiled at build;
# at runtime `next start` needs the workspace links and production deps only).
COPY --from=build --chown=lookahead:lookahead /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml ./
COPY --from=build --chown=lookahead:lookahead /repo/node_modules ./node_modules
COPY --from=build --chown=lookahead:lookahead /repo/packages/engine ./packages/engine
COPY --from=build --chown=lookahead:lookahead /repo/apps/web/package.json /repo/apps/web/next.config.ts ./apps/web/
COPY --from=build --chown=lookahead:lookahead /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=build --chown=lookahead:lookahead /repo/apps/web/.next ./apps/web/.next
COPY --from=build --chown=lookahead:lookahead /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=lookahead:lookahead /repo/data/raw ./data/raw
COPY --chown=lookahead:lookahead docs/forecast_backtest.json ./docs/forecast_backtest.json
RUN mkdir -p /var/lib/lookahead/live && chown -R lookahead:lookahead /var/lib/lookahead
USER lookahead
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
WORKDIR /repo/apps/web
CMD ["pnpm", "exec", "next", "start", "-p", "3000"]
