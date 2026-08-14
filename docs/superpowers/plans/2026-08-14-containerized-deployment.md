# Containerized Deployment (Local Dry Run) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the production container manifests (Dockerfile, production compose, Caddy configs, secrets tooling) and prove them by running the entire stack containerized on this machine, verified end to end over TLS.

**Architecture:** One shared image (multi-stage Dockerfile, full deps, workspace source) runs storefront, console, and worker as three containers. A production-shaped compose adds postgres/pgbouncer/redis/MinIO/one-shot-migrate/Caddy; only Caddy publishes ports. A `Caddyfile.local` with Caddy's internal CA exercises the real on-demand-TLS ask gate against `*.localhost`. Spec: `docs/superpowers/specs/2026-08-14-containerized-deployment-design.md`.

**Tech Stack:** Docker + Compose, node:22-alpine, pnpm 9.12.0 via Corepack, Next 16.3.0, Caddy 2 (stock + xcaddy/cloudflare build), MinIO (S3 driver target), postgres:16-alpine, edoburu/pgbouncer, redis:7-alpine.

## Global Constraints

- Work on a feature branch off master. `pnpm` on the HOST is only via `export PATH="$HOME/.pnpm-shim:$PATH"`; host pnpm is needed only in Tasks 2 and 6.
- Docker Desktop must be running. The DEV compose (`platform-dev` project: ports 5442/6442/6389) may be up simultaneously — the prod compose must not publish any conflicting port (it publishes only 80/443).
- The dev compose, dev Caddyfile, dev pgbouncer files, and all application behaviour stay untouched. The ONLY app-code change permitted is the `STORAGE_FORCE_PATH_STYLE` option in `packages/integrations/src/storage/` (spec amendment).
- The production `infra/caddy/Caddyfile` is not edited. Its contracts bind the compose: service names `console` (port 3001) and `storefront` (port 3000), and `TLS_ASK_SECRET` must be present in BOTH the console and caddy container environments.
- Fail-closed env vars that MUST be in the env file: `DATABASE_URL_APP` (via `pgbouncer:6432`), `DATABASE_URL_MIGRATOR` (via `postgres:5432`, migrate job only), `REDIS_URL` (`redis:6379` — never rely on the worker's silent localhost fallback), `OTP_PEPPER`, `INTERNAL_API_SECRET` (storefront refuses to boot without it), `STORAGE_DRIVER=s3`, `TLS_ASK_SECRET`.
- Exactly ONE storefront replica (one purge reaches one process).
- Every git commit message ends with a blank line then exactly: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Secrets never committed: `.gitignore` gains `infra/env/production.env`, `infra/docker/pgbouncer/userlist.prod.txt`, `infra/caddy/root.crt`.
- Compose commands run from the repo root in the form:
  `docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml <verb>`
  (the `--env-file` supplies `${...}` interpolation; the same file is each app service's `env_file`).

---

### Task 1: `.dockerignore` and the shared image Dockerfile

**Files:**
- Create: `.dockerignore`
- Create: `Dockerfile`

**Interfaces:**
- Consumes: existing app scripts — `pnpm --filter @platform/storefront build` / `start` (port 3000), `@platform/console` (port 3001), `@platform/worker start` (tsx), `@platform/db migrate` / `seed`.
- Produces: an image tagged `platform-app:local` whose working dir is `/app`, with `NODE_ENV=production`, full workspace + `node_modules` + both `.next` builds, no default command. Tasks 4–5 run every app service from it.

- [ ] **Step 1: Write `.dockerignore`**

```
.git
.github
node_modules
**/node_modules
.next
**/.next
.turbo
**/.turbo
dist
**/dist
coverage
**/coverage
*.tsbuildinfo
.env
.env.*
.media
*.log
docs
tasks
.superpowers
.remember
.firecrawl
infra/caddy/data
infra/caddy/config
infra/docker/data
infra/env
apps/*/tests
packages/*/tests
```

(Tests are excluded because both Next apps keep them out of the build typecheck via the `tsconfig.json`/`tsconfig.test.json` split, and nothing runs vitest inside the image.)

- [ ] **Step 2: Write `Dockerfile`**

```dockerfile
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
```

- [ ] **Step 3: Build the image**

Run from the repo root:
```bash
docker build -t platform-app:local .
```
Expected: both `next build` runs succeed inside the image (the same 2/2 that pass on the host). If the storefront build fails on a missing env var, the placeholder list in Step 2 is incomplete — add the named var to BOTH build commands with a `build-stage-placeholder` value and note it in your report; do not weaken any runtime check.

- [ ] **Step 4: Smoke the image**

```bash
docker run --rm platform-app:local node --version
docker run --rm platform-app:local pnpm --version
docker run --rm platform-app:local ls apps/storefront/.next apps/console/.next
```
Expected: `v22.x`, `9.12.0`, both `.next` directories present.

- [ ] **Step 5: Commit**

```bash
git add .dockerignore Dockerfile
git commit -m "feat(infra): shared production image for storefront, console, and worker"
```

---

### Task 2: `STORAGE_FORCE_PATH_STYLE` for the S3 driver

The AWS SDK defaults to virtual-hosted addressing, so a custom endpoint like `http://minio:9000` (or a future self-hosted S3) becomes `http://media.minio:9000` — unresolvable. One env-gated option fixes it; R2/AWS behaviour is unchanged because the default stays off. This is the spec's single approved code amendment.

**Files:**
- Modify: `packages/integrations/src/storage/s3.ts` (the `S3Config` type and `new S3Client({...})` at lines ~18–36)
- Modify: `packages/integrations/src/storage/index.ts` (the s3 config assembly at lines ~54–59)

**Interfaces:**
- Consumes: existing `createS3Driver(config: S3Config)` and `getStorage()`.
- Produces: `S3Config` gains `forcePathStyle?: boolean`; `getStorage()` sets it from `process.env.STORAGE_FORCE_PATH_STYLE === "true"`. Task 4's env file sets `STORAGE_FORCE_PATH_STYLE=true`.

- [ ] **Step 1: Make the edits**

In `s3.ts`, add to the `S3Config` type:

```ts
  /**
   * Path-style addressing (endpoint.com/bucket/key instead of
   * bucket.endpoint.com/key). Required for MinIO and most self-hosted
   * S3; harmless for R2. The SDK default (virtual-hosted) stays for
   * anything that does not opt in.
   */
  forcePathStyle?: boolean;
```

and thread it into the client:

```ts
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle ?? false,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
```

In `index.ts`, add one line to the config object passed to `createS3Driver` (alongside `endpoint`, `region`, etc.):

```ts
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
```

- [ ] **Step 2: Verify nothing regressed**

Run (host shell): `export PATH="$HOME/.pnpm-shim:$PATH" && pnpm typecheck && pnpm lint && pnpm --filter @platform/integrations test`
Expected: clean; the integrations unit suite passes at its pre-existing count (46). No new unit test is added: an assertion on the SDK client's internal config would be a test that cannot fail meaningfully; the behavioural proof is Task 5's end-to-end media upload through MinIO, which fails without this change.

- [ ] **Step 3: Commit**

```bash
git add packages/integrations/src/storage/s3.ts packages/integrations/src/storage/index.ts
git commit -m "feat(integrations): env-gated path-style addressing for the S3 driver"
```

---

### Task 3: Caddy — local config and the production xcaddy image

**Files:**
- Create: `infra/caddy/Caddyfile.local`
- Create: `infra/caddy/Dockerfile`

**Interfaces:**
- Consumes: the production `Caddyfile`'s contracts (service names, ask URL).
- Produces: `Caddyfile.local` mounted by Task 4's caddy service; `infra/caddy/Dockerfile` building the image the production Caddyfile needs later (not used by the local compose).

- [ ] **Step 1: Write `infra/caddy/Caddyfile.local`**

```
# Local dry run. Same shape as the production Caddyfile with two
# differences: certificates come from Caddy's internal CA
# (local_certs), and the hostnames are *.localhost. The on-demand-TLS
# ask gate is IDENTICAL to production on purpose — issuance for
# acme.localhost genuinely round-trips through the console's
# verify-domain endpoint with TLS_ASK_SECRET, and an unverified
# hostname is genuinely refused a certificate.
#
# No HSTS here: a Strict-Transport-Security header on *.localhost
# would poison the developer's browser for every local project.

{
	local_certs

	on_demand_tls {
		ask http://console:3001/api/internal/verify-domain?secret={$TLS_ASK_SECRET}
		interval 2m
		burst 5
	}

	servers {
		trusted_proxies static private_ranges
	}
}

# ── Merchant console ────────────────────────────────────────────
console.localhost {
	reverse_proxy console:3001 {
		header_up X-Forwarded-Host {host}
		header_up X-Real-IP {remote_host}
	}

	header {
		X-Frame-Options "DENY"
		X-Content-Type-Options "nosniff"
		-Server
	}
}

# ── Internal endpoints must never be publicly reachable ─────────
console.localhost/api/internal/* {
	respond 404
}

# ── Product media (MinIO stands in for R2) ──────────────────────
# MEDIA_PUBLIC_BASE_URL=https://media.localhost, and media rows store
# bare object keys, so the public URL is /<key>. MinIO serves objects
# at /<bucket>/<key>; the rewrite inserts the bucket.
media.localhost {
	rewrite * /media{uri}
	reverse_proxy minio:9000
}

# ── Storefronts (on-demand TLS, the production path) ────────────
:443 {
	tls {
		on_demand
	}

	reverse_proxy storefront:3000 {
		header_up X-Forwarded-Host {host}
		header_up X-Real-IP {remote_host}
	}

	header {
		X-Content-Type-Options "nosniff"
		-Server
	}
}
```

- [ ] **Step 2: Write `infra/caddy/Dockerfile`** (the production image — built and validated now, served when a real domain exists)

```dockerfile
# Production Caddy. The stock image cannot serve the wildcard
# *.shops.<domain> block: its DNS-01 challenge needs the third-party
# caddy-dns/cloudflare module, hence the xcaddy build.
FROM caddy:2-builder AS builder

RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

- [ ] **Step 3: Validate both configs**

```bash
docker build -t platform-caddy:local infra/caddy
docker run --rm -v "$PWD/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -e TLS_ASK_SECRET=validate-only -e CLOUDFLARE_API_TOKEN=validate-only \
  platform-caddy:local caddy validate --config /etc/caddy/Caddyfile
docker run --rm -v "$PWD/infra/caddy/Caddyfile.local:/etc/caddy/Caddyfile:ro" \
  -e TLS_ASK_SECRET=validate-only \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
```
Expected: the xcaddy image builds, and BOTH validations print `Valid configuration`. (The production Caddyfile validating against the xcaddy image proves the cloudflare module resolves; it would fail against stock caddy.)

- [ ] **Step 4: Commit**

```bash
git add infra/caddy/Caddyfile.local infra/caddy/Dockerfile
git commit -m "feat(infra): local Caddy config with the real TLS-ask gate, and the production xcaddy image"
```

---

### Task 4: Secrets tooling and the production compose

**Files:**
- Create: `infra/env/production.env.example`
- Create: `infra/scripts/gen-env.sh`
- Create: `infra/docker/docker-compose.prod.yml`
- Modify: `.gitignore` (three entries)

**Interfaces:**
- Consumes: `platform-app:local` image behaviour (Task 1), `Caddyfile.local` (Task 3), `STORAGE_FORCE_PATH_STYLE` (Task 2), the existing `infra/docker/postgres/init/01-roles.sh` and `pgbouncer.ini`.
- Produces: the compose file Task 5 brings up; `infra/scripts/gen-env.sh` writing `infra/env/production.env` + `infra/docker/pgbouncer/userlist.prod.txt`.

- [ ] **Step 1: Write `infra/env/production.env.example`**

```bash
# ─────────────────────────────────────────────────────────────
# Production environment template.
# NEVER edit this into a real env file by hand — run
# infra/scripts/gen-env.sh, which generates the real file AND the
# matching PgBouncer userlist from the same values so the two cannot
# drift. The generated file is git-ignored.
#
# Every value here is documented with its failure mode, because half
# of them fail CLOSED in production on purpose.
# ─────────────────────────────────────────────────────────────

NODE_ENV=production

# Database passwords. Consumed by the postgres first-init script
# (roles are created once, on first initdb of the volume) and baked
# into the URLs below by gen-env.sh.
POSTGRES_PASSWORD=GENERATED
APP_DB_PASSWORD=GENERATED
MIGRATOR_DB_PASSWORD=GENERATED

# app traffic through PgBouncer (transaction pooling); migrations
# direct to Postgres. Unset: the process throws on first query.
DATABASE_URL_APP=postgres://app_user:GENERATED@pgbouncer:6432/platform
DATABASE_URL_MIGRATOR=postgres://app_migrator:GENERATED@postgres:5432/platform

# Unset: core throws at boot; the WORKER would silently retry
# localhost:6379 forever — never rely on its fallback.
REDIS_URL=redis://redis:6379

# Fail-closed at login time.
OTP_PEPPER=GENERATED
SESSION_SECRET=GENERATED

# The storefront REFUSES TO BOOT without this (instrumentation.ts).
INTERNAL_API_SECRET=GENERATED

# Caddy's on-demand-TLS ask secret. Needed by the console (verifier)
# AND by Caddy's own process env — {$TLS_ASK_SECRET} in the Caddyfile
# substitutes EMPTY if Caddy's environment lacks it, and every ask
# then 403s: fail-closed, but it looks like an outage.
TLS_ASK_SECRET=GENERATED

# Console/worker → storefront purge. Fail-soft: unset means catalog
# edits wait out the 300s cache TTL and every write logs
# cache.purge_unconfigured.
STOREFRONT_INTERNAL_ORIGIN=http://storefront:3000

# Storage. Production refuses to start with STORAGE_DRIVER unset.
# The dry run uses MinIO; a real deployment points the same five
# values at R2 (and can usually drop STORAGE_FORCE_PATH_STYLE).
STORAGE_DRIVER=s3
STORAGE_ENDPOINT=http://minio:9000
STORAGE_REGION=us-east-1
STORAGE_BUCKET=media
STORAGE_ACCESS_KEY_ID=GENERATED
STORAGE_SECRET_ACCESS_KEY=GENERATED
STORAGE_FORCE_PATH_STYLE=true

# MinIO's root credentials — kept identical to the storage keys so
# one generation covers both (fine for a single-tenant object store).
MINIO_ROOT_USER=GENERATED
MINIO_ROOT_PASSWORD=GENERATED

# Absolute public base for product media; JSON-LD needs absolutes.
# Caddy serves media.localhost -> MinIO. Real deployment: the R2/CDN
# public base.
MEDIA_PUBLIC_BASE_URL=https://media.localhost

# Envelope-encryption master key (Phase 3+; fail-closed on first use).
CREDENTIALS_MASTER_KEY=GENERATED_BASE64

# Domain verification targets (worker). The default CNAME is
# meaningless until a real domain exists — set then.
CUSTOM_DOMAIN_CNAME_TARGET=domains.platform.in
CUSTOM_DOMAIN_A_RECORDS=

# Seed derives tenant hostnames from this and STRIPS any port:
# acme.localhost, globex.localhost.
STOREFRONT_ROOT_DOMAIN=localhost

# OTP delivery: the console provider THROWS in production, so
# requesting an OTP through the deployed console will 500 until the
# MSG91 provider exists (Phase 4). Verification uses a SQL-seeded
# session instead. Known, deliberate.
OTP_PROVIDER=console
```

- [ ] **Step 2: Write `infra/scripts/gen-env.sh`**

```bash
#!/usr/bin/env bash
# Generates infra/env/production.env and the matching PgBouncer
# userlist from one set of secrets, so the two can never drift.
# Refuses to overwrite an existing env file: these values include the
# database passwords the postgres volume was initialised with —
# regenerating them does NOT change the database, it just locks
# every app out. To truly start over: compose down -v, delete the
# env file, re-run this script.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="env/production.env"
USERLIST="docker/pgbouncer/userlist.prod.txt"

if [ -f "$ENV_FILE" ]; then
  echo "✗ $ENV_FILE already exists. Refusing to overwrite (the postgres volume was initialised with these passwords)." >&2
  exit 1
fi

rand_hex() { openssl rand -hex 32; }

POSTGRES_PASSWORD="$(rand_hex)"
APP_DB_PASSWORD="$(rand_hex)"
MIGRATOR_DB_PASSWORD="$(rand_hex)"
OTP_PEPPER="$(rand_hex)"
SESSION_SECRET="$(rand_hex)"
INTERNAL_API_SECRET="$(rand_hex)"
TLS_ASK_SECRET="$(rand_hex)"
STORAGE_ACCESS_KEY_ID="$(openssl rand -hex 10)"
STORAGE_SECRET_ACCESS_KEY="$(rand_hex)"
CREDENTIALS_MASTER_KEY="$(openssl rand -base64 32)"

mkdir -p env

cat > "$ENV_FILE" <<EOF
# Generated by infra/scripts/gen-env.sh — do not commit.
# Field documentation lives in production.env.example.
NODE_ENV=production
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
APP_DB_PASSWORD=${APP_DB_PASSWORD}
MIGRATOR_DB_PASSWORD=${MIGRATOR_DB_PASSWORD}
DATABASE_URL_APP=postgres://app_user:${APP_DB_PASSWORD}@pgbouncer:6432/platform
DATABASE_URL_MIGRATOR=postgres://app_migrator:${MIGRATOR_DB_PASSWORD}@postgres:5432/platform
REDIS_URL=redis://redis:6379
OTP_PEPPER=${OTP_PEPPER}
SESSION_SECRET=${SESSION_SECRET}
INTERNAL_API_SECRET=${INTERNAL_API_SECRET}
TLS_ASK_SECRET=${TLS_ASK_SECRET}
STOREFRONT_INTERNAL_ORIGIN=http://storefront:3000
STORAGE_DRIVER=s3
STORAGE_ENDPOINT=http://minio:9000
STORAGE_REGION=us-east-1
STORAGE_BUCKET=media
STORAGE_ACCESS_KEY_ID=${STORAGE_ACCESS_KEY_ID}
STORAGE_SECRET_ACCESS_KEY=${STORAGE_SECRET_ACCESS_KEY}
STORAGE_FORCE_PATH_STYLE=true
MINIO_ROOT_USER=${STORAGE_ACCESS_KEY_ID}
MINIO_ROOT_PASSWORD=${STORAGE_SECRET_ACCESS_KEY}
MEDIA_PUBLIC_BASE_URL=https://media.localhost
CREDENTIALS_MASTER_KEY=${CREDENTIALS_MASTER_KEY}
CUSTOM_DOMAIN_CNAME_TARGET=domains.platform.in
CUSTOM_DOMAIN_A_RECORDS=
STOREFRONT_ROOT_DOMAIN=localhost
OTP_PROVIDER=console
EOF

cat > "$USERLIST" <<EOF
; Generated by infra/scripts/gen-env.sh — do not commit.
; Plaintext entries let PgBouncer perform SCRAM pass-through, exactly
; as the dev userlist does; the difference is these are generated
; secrets on a 0600 file, not committed dev constants.
"app_user" "${APP_DB_PASSWORD}"
"app_migrator" "${MIGRATOR_DB_PASSWORD}"
EOF

chmod 600 "$ENV_FILE" "$USERLIST"

echo "✔ Wrote $ENV_FILE and $USERLIST (mode 0600)."
```

- [ ] **Step 3: Write `infra/docker/docker-compose.prod.yml`**

```yaml
name: platform-prod

# Production-shaped stack, run locally for the dry run and copied to a
# VPS later. Differences from that future VPS run are confined to env
# values and the Caddy image/config (see docs/DEPLOYMENT.md).
#
# Only Caddy publishes ports. Everything else — including Postgres —
# is reachable solely on the compose network; DB access from outside
# goes through `docker compose exec postgres psql` or one-shot app
# containers.

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: platform
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      APP_DB_USER: app_user
      APP_DB_PASSWORD: ${APP_DB_PASSWORD}
      MIGRATOR_DB_USER: app_migrator
      MIGRATOR_DB_PASSWORD: ${MIGRATOR_DB_PASSWORD}
      POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256"
    volumes:
      - pgdata_prod:/var/lib/postgresql/data
      - ./postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d platform"]
      interval: 5s
      timeout: 3s
      retries: 20
    command:
      - postgres
      - -c
      - max_connections=200

  pgbouncer:
    image: edoburu/pgbouncer:latest
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - ./pgbouncer/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro
      - ./pgbouncer/userlist.prod.txt:/etc/pgbouncer/userlist.txt:ro
    healthcheck:
      test: ["CMD-SHELL", "nc -z 127.0.0.1 6432 || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    command:
      - redis-server
      - --appendonly
      - "yes"
    volumes:
      - redisdata_prod:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  minio:
    image: minio/minio:latest
    command: ["server", "/data"]
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes:
      - miniodata:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://127.0.0.1:9000/minio/health/live"]
      interval: 5s
      timeout: 3s
      retries: 20

  # One-shot: bucket + anonymous read policy (derivatives are public
  # objects behind the CDN in production; MinIO mirrors that).
  minio-init:
    image: minio/mc:latest
    depends_on:
      minio:
        condition: service_healthy
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    entrypoint:
      - /bin/sh
      - -c
      - |
        mc alias set local http://minio:9000 "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD" &&
        (mc mb --ignore-existing local/media) &&
        mc anonymous set download local/media
    restart: "no"

  # One-shot: Drizzle migrations + RLS re-apply, as app_migrator,
  # DIRECT to postgres (never PgBouncer).
  migrate:
    build:
      context: ../..
      dockerfile: Dockerfile
    image: platform-app:local
    env_file:
      - ../env/production.env
    command: ["pnpm", "--filter", "@platform/db", "migrate"]
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"

  storefront:
    image: platform-app:local
    env_file:
      - ../env/production.env
    command: ["pnpm", "--filter", "@platform/storefront", "start"]
    depends_on:
      migrate:
        condition: service_completed_successfully
      pgbouncer:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/robots.txt',{headers:{Host:'health.localhost'}}).then(()=>process.exit(0),()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s

  console:
    image: platform-app:local
    env_file:
      - ../env/production.env
    command: ["pnpm", "--filter", "@platform/console", "start"]
    depends_on:
      migrate:
        condition: service_completed_successfully
      pgbouncer:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio-init:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/login').then(()=>process.exit(0),()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s

  worker:
    image: platform-app:local
    env_file:
      - ../env/production.env
    command: ["pnpm", "--filter", "@platform/worker", "start"]
    # The worker drains in-flight jobs on SIGTERM; give it room.
    stop_grace_period: 30s
    depends_on:
      migrate:
        condition: service_completed_successfully
      pgbouncer:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio-init:
        condition: service_completed_successfully

  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    environment:
      # {$TLS_ASK_SECRET} in the Caddyfile substitutes EMPTY if this
      # is missing from Caddy's own environment — every ask then 403s.
      TLS_ASK_SECRET: ${TLS_ASK_SECRET}
    volumes:
      - ../caddy/Caddyfile.local:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      storefront:
        condition: service_healthy
      console:
        condition: service_healthy

volumes:
  pgdata_prod:
  redisdata_prod:
  miniodata:
  caddy_data:
  caddy_config:
```

- [ ] **Step 4: Add the `.gitignore` entries**

Append to `.gitignore`:

```
infra/env/production.env
infra/docker/pgbouncer/userlist.prod.txt
infra/caddy/root.crt
```

- [ ] **Step 5: Generate secrets and validate the compose**

```bash
bash infra/scripts/gen-env.sh
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml config --quiet && echo VALID
git status --short   # generated files must NOT appear
```
Expected: `✔ Wrote ...`, `VALID`, and git shows only the four new/modified tracked files.

- [ ] **Step 6: Commit**

```bash
git add infra/env/production.env.example infra/scripts/gen-env.sh infra/docker/docker-compose.prod.yml .gitignore
git commit -m "feat(infra): production compose, secrets generator, and env template"
```

---

### Task 5: Bring-up and the seven-point verification

This is the integration task: expect iteration. When something fails, fix the MANIFESTS (compose/env/Caddy/Dockerfile) — application behaviour is verified and off-limits except where a manifest fact proves wrong. Record every deviation in your report.

**Files:**
- Modify (only if bring-up demands it): the Task 1–4 artifacts.

**Interfaces:**
- Consumes: everything above.
- Produces: a verified running stack, and the observed facts Task 6's docs must record.

- [ ] **Step 1: Bring the stack up**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml up -d --build
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml ps
```
Expected: `migrate` and `minio-init` exited 0; postgres/pgbouncer/redis/minio healthy; storefront/console healthy; worker and caddy running. Debug order for failures: `logs migrate` (DB URLs), `logs storefront` (INTERNAL_API_SECRET boot check), `logs worker` (REDIS_URL, storage), `logs caddy` (Caddyfile syntax).

- [ ] **Step 2: Seed and create the staff user + session**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml run --rm migrate pnpm --filter @platform/db seed
TOKEN=$(openssl rand -hex 32)
echo "$TOKEN" > /tmp/console-session-token   # keep for Step 5
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml exec -T postgres \
  psql -U postgres -d platform <<SQL
INSERT INTO users (id, phone_e164, name)
VALUES (gen_random_uuid(), '+919876543210', 'Dry Run Owner');
INSERT INTO tenant_members (tenant_id, user_id, role, accepted_at)
SELECT t.id, u.id, 'owner', now() FROM tenants t, users u
WHERE t.slug = 'acme' AND u.phone_e164 = '+919876543210';
INSERT INTO sessions (id, token_hash, user_id, tenant_id, expires_at, idle_expires_at)
SELECT gen_random_uuid(), encode(sha256('$TOKEN'::bytea), 'hex'), u.id, t.id,
       now() + interval '1 day', now() + interval '1 day'
FROM tenants t, users u
WHERE t.slug = 'acme' AND u.phone_e164 = '+919876543210';
SQL
```
Expected: seed reports the two tenants; three INSERTs succeed. Confirm the seeded hostnames are port-less: `... exec -T postgres psql -U postgres -d platform -c "SELECT hostname FROM domains;"` → `acme.localhost`, `globex.localhost`.

- [ ] **Step 3: Export Caddy's root CA (for honest TLS verification)**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml \
  cp caddy:/data/caddy/pki/authorities/local/root.crt infra/caddy/root.crt
```
Use `--cacert infra/caddy/root.crt` on every curl below (fall back to `-k` only if the copy path differs, and say so in the report).

- [ ] **Step 4: Verify TLS issuance — both directions**

```bash
# Verified tenant hostname: cert issued on demand, catalog served.
curl -sS --cacert infra/caddy/root.crt --resolve acme.localhost:443:127.0.0.1 \
  https://acme.localhost/ | grep -i -o "acme" | head -1

# Unverified hostname: the ask endpoint 403s and NO certificate is issued.
curl -sS --cacert infra/caddy/root.crt --resolve unknown.localhost:443:127.0.0.1 \
  https://unknown.localhost/ ; echo "exit=$?"
```
Expected: the first returns Acme markup; the second FAILS the TLS handshake (curl exit 35/60, no HTTP response). `docker compose ... logs console | grep verify-domain` shows the 200 for acme.localhost and 403/404 for unknown.localhost.

- [ ] **Step 5: Settings write → immediate robots.txt flip (Redis invalidation across containers)**

```bash
TOKEN=$(cat /tmp/console-session-token)
curl -sS --cacert infra/caddy/root.crt --resolve acme.localhost:443:127.0.0.1 \
  https://acme.localhost/robots.txt          # expect Allow + Sitemap
curl -sS --cacert infra/caddy/root.crt --resolve console.localhost:443:127.0.0.1 \
  -X PUT https://console.localhost/api/settings \
  -H "content-type: application/json" \
  -H "Cookie: __Host-console_session=$TOKEN" \
  -d '{"searchIndexing":"noindex"}'          # expect {"searchIndexing":"noindex","changed":true,...}
curl -sS --cacert infra/caddy/root.crt --resolve acme.localhost:443:127.0.0.1 \
  https://acme.localhost/robots.txt          # expect Disallow: / IMMEDIATELY
# restore
curl -sS --cacert infra/caddy/root.crt --resolve console.localhost:443:127.0.0.1 \
  -X PUT https://console.localhost/api/settings \
  -H "content-type: application/json" -H "Cookie: __Host-console_session=$TOKEN" \
  -d '{"searchIndexing":"auto"}'
```
Expected: the flip is immediate (no 300 s wait). Also confirm the blackhole: `curl -sS -o /dev/null -w "%{http_code}" --cacert infra/caddy/root.crt --resolve console.localhost:443:127.0.0.1 "https://console.localhost/api/internal/verify-domain?domain=acme.localhost&secret=anything"` → `404` (the public path must be blackholed while Caddy's internal ask still works — the Step 4 logs already proved the internal path).

- [ ] **Step 6: Media end to end (S3 driver → worker → MinIO → PDP)**

First read `apps/console/src/app/api/media/upload/route.ts` to confirm the multipart field names and required headers, then upload a real image (generate one: `docker compose ... exec -T storefront node -e "..."` is overkill — create a small PNG on the host with any tool, or reuse a repo fixture if one exists under `apps/*/tests`). Shape (adjust field names to what the route actually reads):

```bash
curl -sS --cacert infra/caddy/root.crt --resolve console.localhost:443:127.0.0.1 \
  -X POST https://console.localhost/api/media/upload \
  -H "Cookie: __Host-console_session=$TOKEN" \
  -F "file=@/tmp/test-image.png;type=image/png"
```
Expected: 200/201 with a media id; `docker compose ... logs worker` shows the job completing; the media row goes `ready` (`exec postgres psql -c "SELECT status, storage_key FROM media ORDER BY created_at DESC LIMIT 1;"`); and the derivative is publicly served:
```bash
curl -sS -o /dev/null -w "%{http_code}" --cacert infra/caddy/root.crt \
  --resolve media.localhost:443:127.0.0.1 \
  "https://media.localhost/<a derivative storage_key from the media_derivatives table>"
```
→ `200`. (Attach the media to a product via the console API and fetch the PDP if time permits — the 200 on the derivative URL is the required proof.)

- [ ] **Step 7: Catalog purge across the internal network**

```bash
# Warm the cache, write a title change through the console, re-fetch.
curl -sS --cacert infra/caddy/root.crt --resolve acme.localhost:443:127.0.0.1 https://acme.localhost/ > /tmp/before.html
# PUT /api/products/<id> with a changed title (list products first:
# exec postgres psql -c "SELECT id, title FROM products WHERE tenant_id = (SELECT id FROM tenants WHERE slug='acme') LIMIT 3;"
# then read apps/console/tests/product-crud.integration.test.ts's productPayload() for the minimal PUT body shape).
curl -sS --cacert infra/caddy/root.crt --resolve acme.localhost:443:127.0.0.1 https://acme.localhost/ | grep -o "<the new title>"
```
Expected: the new title appears immediately on the storefront (purge crossed console→storefront over the compose network; no TTL wait). `logs storefront` shows the revalidate POST.

- [ ] **Step 8: Record state and commit any manifest fixes**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml ps > /tmp/dry-run-ps.txt
git add -A && git status --short
git commit -m "fix(infra): bring-up fixes from the dry run"   # ONLY if manifests changed; otherwise skip
```
Leave the stack RUNNING for Task 6's writer to spot-check. Report every deviation, every fix, and the exact outputs of Steps 4–7.

---

### Task 6: DEPLOYMENT.md, PROJECT_STATUS, and the dev-untouched proof

**Files:**
- Create: `docs/DEPLOYMENT.md`
- Modify: `PROJECT_STATUS.md` (new verified block; "Last updated"; the Open items row "Run this somewhere that is not this laptop" if present)
- Test: the host test matrix

**Interfaces:**
- Consumes: Task 5's report (observed outputs, any deviations).
- Produces: the runbook and the recorded verification.

- [ ] **Step 1: Write `docs/DEPLOYMENT.md`**

Structure (write real content under each heading, using Task 5's observed facts — this is a runbook someone follows with no other context):

```markdown
# Deployment

## What exists
One shared app image (Dockerfile at the repo root) running storefront,
console, and worker; `infra/docker/docker-compose.prod.yml` for the full
stack (only Caddy publishes ports); `infra/caddy/Caddyfile.local` (local
CA, real on-demand-TLS ask gate) and the production `Caddyfile` +
`infra/caddy/Dockerfile` (xcaddy + cloudflare DNS) for when a real
domain exists.

## Local dry run — bring-up
1. `bash infra/scripts/gen-env.sh`   (once; refuses to overwrite)
2. `docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml up -d --build`
3. Seed + staff user + session:      (the exact commands from Task 5 Steps 2)
4. Export the CA:                    (Task 5 Step 3)

## Verification checklist
(the seven checks with their exact curl commands and expected outputs,
from Task 5 — copy the real commands, not summaries)

## Secrets model
gen-env.sh writes production.env + the PgBouncer userlist from one set
of values (mode 0600, git-ignored). Regenerating does NOT change an
initialised database — see the script's header. TLS_ASK_SECRET goes to
BOTH console and caddy. INTERNAL_API_SECRET: storefront refuses to boot
without it.

## What changes for a real VPS
- Caddy: build `infra/caddy/Dockerfile`, serve the production
  `Caddyfile`, set CLOUDFLARE_API_TOKEN, real domain DNS at Cloudflare.
- Storage: point STORAGE_* at R2; STORAGE_FORCE_PATH_STYLE usually
  false; MEDIA_PUBLIC_BASE_URL = the CDN base; drop minio/minio-init.
- Do NOT run `db:seed` (dev fixtures). Create tenants through onboarding.
- Transport `production.env` via the secret store, never git.
- One storefront replica per purge target (or LB fan-out).
- Known-broken until Phase 4: production console login (OTP provider).

## Teardown
`docker compose ... down` keeps volumes; `down -v` destroys them
(database, media, and the CA — everything).
```

- [ ] **Step 2: Update `PROJECT_STATUS.md`**

Add a verified block "Verified 2026-08-14 (containerized dry run, full stack)" recording: services up, the four live proofs (on-demand cert for acme.localhost via the ask gate; cert REFUSED for unknown.localhost; immediate robots flip through the full chain; media through MinIO; purge across the network) with the ACTUAL observed outputs from Task 5's report; update "Last updated"; adjust the "Run this somewhere that is not this laptop"-shaped open item to point at docs/DEPLOYMENT.md and name what remains (VPS, domain, backups, OTP).

- [ ] **Step 3: Prove dev is untouched**

```bash
export PATH="$HOME/.pnpm-shim:$PATH"
git diff master --stat -- infra/docker/docker-compose.dev.yml infra/caddy/Caddyfile   # must be empty
pnpm test && pnpm test:integration
```
Expected: no diff on the dev compose or production Caddyfile; 325 unit / 191 integration, all green (the dev infra on 5442/6442/6389 serves them exactly as before).

- [ ] **Step 4: Tear down the dry-run stack**

```bash
docker compose --env-file infra/env/production.env -f infra/docker/docker-compose.prod.yml down
```
(Volumes intentionally kept; note it in the report.)

- [ ] **Step 5: Commit**

```bash
git add docs/DEPLOYMENT.md PROJECT_STATUS.md
git commit -m "docs: deployment runbook and the containerized dry-run verification"
```

---

## Notes for the reviewer

- Spec: `docs/superpowers/specs/2026-08-14-containerized-deployment-design.md`. Task 2 is the spec's single approved code amendment (path-style flag); everything else is manifests, tooling, and docs.
- Task 5 is expected to loop: manifests get fixed, app behaviour does not. Judge its report by whether every deviation is recorded with the observed failure that forced it.
- The `console.localhost/api/internal/*` blackhole plus a WORKING internal ask (Step 4 logs + Step 5's 404) is the security-critical pair — both directions must be in the report.
