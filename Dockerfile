# syntax=docker/dockerfile:1

# ── Build stage ─────────────────────────────────────────────────
# One image for storefront, console, and worker: the workspace ships
# raw TypeScript (Next transpiles it, the worker runs tsx), so every
# process needs source + full deps anyway. Slim per-app images are a
# deliberate non-goal (spec §1).
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app
COPY . .

# The build scripts pipe `dotenv -e ../../.env`; the real .env is
# dockerignored. An empty file keeps the scripts byte-identical to
# what has been verified on the host for weeks.
RUN touch .env

RUN pnpm install --frozen-lockfile

# next build prerenders /404 and can bootstrap instrumentation, and
# several modules fail CLOSED under NODE_ENV=production when their env
# is missing. These placeholders exist ONLY in this stage; the runtime
# stage never declares them, so the fail-closed guards still protect a
# misconfigured deployment.
RUN INTERNAL_API_SECRET=build-stage-placeholder \
    TLS_ASK_SECRET=build-stage-placeholder \
    OTP_PEPPER=build-stage-placeholder \
    SESSION_SECRET=build-stage-placeholder \
    STORAGE_DRIVER=local \
    pnpm --filter @platform/storefront build \
 && INTERNAL_API_SECRET=build-stage-placeholder \
    TLS_ASK_SECRET=build-stage-placeholder \
    OTP_PEPPER=build-stage-placeholder \
    SESSION_SECRET=build-stage-placeholder \
    STORAGE_DRIVER=local \
    pnpm --filter @platform/console build

# ── Runtime stage ───────────────────────────────────────────────
# Same base; copying /app drops the global pnpm store and build caches
# living outside /app. Deliberately NO default command — the compose
# file names the process each container runs.
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

ENV NODE_ENV=production

WORKDIR /app
COPY --from=build /app /app
