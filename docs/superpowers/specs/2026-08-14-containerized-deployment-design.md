# Design — Containerized deployment, local-first dry run

**Date:** 2026-08-14
**Status:** Approved by the owner (scope, image strategy, and all four design sections)

Phase 1 is feature-complete and merged; nothing runs anywhere but this
laptop, from source, against dev containers. This work produces the
production container manifests — Dockerfile, production compose, Caddy —
and proves them by running the ENTIRE stack containerized on this machine.
The real VPS, real domain, and Cloudflare are a follow-up spec; the
hosting decision itself (VPS + Docker) is locked and not relitigated here.

Scope decisions made by the owner at session start:

- **Local-first dry run.** No provisioning, no remote, no real domain.
  The deliverable is manifests that are production-shaped and a verified
  local bring-up, so the VPS step later is "copy files, change env".
- **One shared image, three containers.** A single multi-stage Dockerfile;
  storefront, console, and worker run from the same image with different
  commands. Per-app `output: "standalone"` slim images were rejected for
  now: the workspace ships raw TypeScript (Next transpiles it, the worker
  runs tsx), so every process needs source + full deps anyway, and one
  Dockerfile is one thing to debug on first containerization. Slimming is
  a named follow-up, not a requirement.
- **Zero application-code changes, with one amendment found during
  planning:** the S3 storage driver constructs its `S3Client` without
  `forcePathStyle`, so any custom endpoint (MinIO here, and equally R2 or
  self-hosted S3 later) gets virtual-hosted addressing —
  `bucket.minio:9000`, which resolves nowhere. The plan adds one
  env-gated option (`STORAGE_FORCE_PATH_STYLE=true` →
  `forcePathStyle: true`, default unchanged) in
  `packages/integrations/src/storage/`. Everything else stays code-free:
  verification uses a SQL-seeded session + curl for console writes (the
  settings live pass already did exactly this). The OTP provider (throws
  in production; MSG91 is a Phase 4 stub) is explicitly NOT solved here.

---

## Facts the design rests on

Verified against the tree at master (settings merge `57d637a`):

- `infra/` today: dev compose (postgres 16-alpine on 5442, edoburu/pgbouncer
  on 6442 in transaction mode, redis 7-alpine AOF on 6389), a first-init
  role script (`infra/docker/postgres/init/01-roles.sh` — creates
  `app_migrator` BYPASSRLS + `app_user`; runs only on first initdb), and a
  production-shaped `infra/caddy/Caddyfile` that nothing runs.
- The Caddyfile's contracts: service names `console:3001` / `storefront:3000`;
  `on_demand_tls { ask http://console:3001/api/internal/verify-domain?secret={$TLS_ASK_SECRET} }`;
  `/api/internal/*` blackholed publicly; the `*.shops.platform.in` block
  needs the third-party `caddy-dns/cloudflare` module — a stock Caddy image
  cannot serve it (xcaddy build required).
- Processes: storefront (`next start --port 3000`), console (`--port 3001`),
  worker (`tsx src/index.ts`, no build artifact, graceful SIGTERM). All three
  start scripts pipe `dotenv -e ../../.env -v NODE_ENV=production` — the
  `-v` override is load-bearing (session cookies, OTP logging, fake carrier
  all fail OPEN on non-production NODE_ENV); an absent `.env` makes
  dotenv-cli a no-op, so container env works through the existing scripts.
- Worker's `import "./env"` must stay its first import; `queues.ts` falls
  back silently to `redis://localhost:6379` if `REDIS_URL` is unset.
- Env surface (fail-closed in production): `DATABASE_URL_APP` (via
  PgBouncer, `prepare: false`), `DATABASE_URL_MIGRATOR` (direct Postgres,
  migrate job only), `REDIS_URL`, `OTP_PEPPER`, `INTERNAL_API_SECRET`
  (storefront refuses to boot without it), `STORAGE_DRIVER` (unset =
  refuse; blank = unset), `TLS_ASK_SECRET` (needed by console AND by
  Caddy's process env — `{$TLS_ASK_SECRET}` substitutes empty otherwise
  and every ask 403s). Fail-soft: `STOREFRONT_INTERNAL_ORIGIN` (unset =
  purges skipped, 300 s TTL backstop). `MEDIA_LOCAL_ROOT` must be absolute
  and shared if the local driver were used.
- Media: with the local driver `publicUrl()` is null and NO route serves
  `/media` — production effectively requires the S3 driver
  (`packages/integrations/src/storage/s3.ts`, built for R2/S3/MinIO/B2)
  plus `MEDIA_PUBLIC_BASE_URL`. Console and worker must share the storage
  backend.
- One purge reaches ONE storefront process — this compose runs exactly one
  storefront replica, by design.
- Docker readiness: no Dockerfile, no .dockerignore anywhere; Node >= 22
  (`engines`), `packageManager: pnpm@9.12.0`; no `output: "standalone"`;
  console's `serverExternalPackages: ["sharp", "bullmq", "ioredis",
  "@aws-sdk/client-s3"]`.
- Blueprint §8: images tagged by SHA, expand-only migrations before rolling
  restart, Cloudflare in front, R2 for objects, backups with tested
  restores — the follow-up items this spec deliberately defers.

---

## 1. The image

One multi-stage `Dockerfile` at the repo root.

- **Build stage:** `node:22-alpine`; enable Corepack and activate
  `pnpm@9.12.0`; copy the workspace (filtered by `.dockerignore`);
  `pnpm install --frozen-lockfile`; build both Next apps via the existing
  scripts (`pnpm --filter @platform/storefront build`, same for console) so
  the `NODE_ENV=production` override and dotenv behaviour are identical to
  what has been verified for weeks. `sharp` installs its musl prebuilt on
  alpine.
- **Runtime stage:** `node:22-alpine` + Corepack pnpm; copy the full
  workspace + `node_modules` + both `.next` outputs from the build stage.
  Full deps are kept deliberately: the worker needs tsx, and Next needs its
  runtime; pruning is the follow-up optimization. No ENTRYPOINT default —
  compose supplies each service's command (`pnpm --filter @platform/<app>
  start`). `NODE_ENV=production` is also set in the image environment as a
  second layer of the same guarantee the scripts provide.
- **`.dockerignore`** (new): `.git`, `node_modules`, `.next`, `.media`,
  `.superpowers`, `.remember`, `.firecrawl`, `docs`, `infra/caddy/data`,
  `infra/caddy/config`, `infra/docker/data`, `*.md` at root except what the
  build needs, test artifacts. Seeded from `.gitignore`.
- **No app code changes.** The existing `start` scripts run in-container;
  the repo-root `.env` is absent from the image (dockerignored), so all
  configuration arrives as container environment.

## 2. Production-shaped compose

New `infra/docker/docker-compose.prod.yml` (project name `platform-prod`),
run locally for the dry run and copied to the VPS later. Services:

| Service | Image | Notes |
| :--- | :--- | :--- |
| `postgres` | `postgres:16-alpine` | Same first-init roles script mounted; SCRAM; passwords from env; NOT port-published (internal network only) |
| `pgbouncer` | `edoburu/pgbouncer` | Transaction mode, same ini; userlist generated by the secrets script; internal only |
| `redis` | `redis:7-alpine` | AOF on; internal only |
| `minio` | `minio/minio` | S3 target for the dry run (production swaps endpoint to R2 — same driver, same code path); a one-shot `mc` init container creates the bucket + public-read policy |
| `migrate` | the shared app image | One-shot: `pnpm --filter @platform/db migrate` over `DATABASE_URL_MIGRATOR` (direct to `postgres:5432`, not PgBouncer). Apps `depends_on` it completing successfully |
| `storefront` | shared image | `pnpm --filter @platform/storefront start`; internal only (Caddy fronts it); exactly ONE replica |
| `console` | shared image | `pnpm --filter @platform/console start`; internal only |
| `worker` | shared image | `pnpm --filter @platform/worker start`; `stop_grace_period` honouring its SIGTERM handler |
| `caddy` | stock `caddy` (local) / xcaddy image (future VPS) | The ONLY service with published ports (80/443); volumes for its data/config dirs |

Wiring facts encoded in the compose: `DATABASE_URL_APP` points at
`pgbouncer:6432`; `DATABASE_URL_MIGRATOR` at `postgres:5432`; `REDIS_URL`
at `redis:6379` for every app container (never defaulted);
`STOREFRONT_INTERNAL_ORIGIN=http://storefront:3000` for console and worker;
`STORAGE_DRIVER=s3` with MinIO endpoint/bucket/creds for console and
worker; `TLS_ASK_SECRET` in BOTH the console and caddy environments;
`INTERNAL_API_SECRET` in storefront, console, and worker. Healthchecks on
postgres/pgbouncer/redis/minio; the app services get simple HTTP
healthchecks.

**Secrets:** a committed, fully-commented template
`infra/env/production.env.example` lists every variable above with its
failure mode. A new script `infra/scripts/gen-env.sh` writes the
gitignored real file (`infra/env/production.env`) with
`openssl rand`-generated secrets AND the matching PgBouncer `userlist.txt`
from the same values, so the two can never drift. Compose reads the env
file via `env_file:`. `.gitignore` gains `infra/env/production.env` and the
generated userlist.

## 3. Caddy

- **`infra/caddy/Caddyfile.local`** (new, for the dry run): global
  `local_certs` (Caddy's internal CA) and the SAME
  `on_demand_tls { ask http://console:3001/api/internal/verify-domain?secret={$TLS_ASK_SECRET} }`
  wiring as production. Sites: `console.localhost` → `console:3001` with
  `/api/internal/*` responding 404; `media.localhost` → `minio:9000`
  (path-rewritten to the bucket) so PDP images load over TLS without mixed
  content; catch-all `:443` with `tls { on_demand }` → `storefront:3000`.
  Same `trusted_proxies` and header_up lines as production. Certificate
  issuance for `acme.localhost` therefore genuinely exercises the
  TLS-ask gate — including the refusal path for unverified hostnames.
- **`infra/caddy/Dockerfile`** (new): xcaddy build with
  `caddy-dns/cloudflare`, producing the image the production `Caddyfile`
  (wildcard DNS-01 block) needs. Built and smoke-tested now
  (`caddy validate` against the production Caddyfile); actually served
  only when a real domain exists.
- The production `Caddyfile` is untouched.
- `*.localhost` resolves to loopback on this machine (every prior live
  pass relied on it); `MEDIA_PUBLIC_BASE_URL=https://media.localhost/<bucket>`.

## 4. Verification, docs, out of scope

**The dry run passes when, from a clean `docker compose -f
infra/docker/docker-compose.prod.yml up -d --build`:**

1. All services healthy; `migrate` exits 0; seed applied via a one-shot
   container (`docker compose run --rm migrate pnpm --filter @platform/db
   seed` — postgres is not port-published, so all DB access goes through
   containers; the staff-user and session SQL likewise run through
   `docker compose exec postgres psql`). Dev-only seed data is fine for a
   dry run.
2. `https://acme.localhost` (curl with Caddy's local CA, and a browser)
   serves Acme's catalog through Caddy, with a certificate issued
   on-demand — which proves the ask endpoint answered 200 with the right
   `TLS_ASK_SECRET`.
3. An unverified hostname (e.g. `https://unknown.localhost`) is REFUSED a
   certificate — the ask endpoint's 403 path, live.
4. A console settings write (SQL-seeded session + curl through
   `https://console.localhost`) flips `https://acme.localhost/robots.txt`
   immediately — Redis invalidation across containers.
5. A media upload (curl multipart to the console API) is processed by the
   worker and the PDP renders the derivative from
   `https://media.localhost/...` — the S3 driver end to end.
6. A catalog title edit purges the storefront cache across the internal
   network (visible on next fetch, no TTL wait).
7. The dev workflow is untouched: `docker-compose.dev.yml` unchanged,
   full unit + integration matrix still green on the host.

**Docs:** new `docs/DEPLOYMENT.md` — bring-up runbook (secrets generation,
compose up, seed, staff SQL, verification checklist) plus an explicit
"what changes for the real VPS" section (xcaddy image + production
Caddyfile, R2 instead of MinIO, real domain + Cloudflare token, env file
transport, `pnpm db:seed` NOT run). PROJECT_STATUS gains the dry-run
verified block.

**Out of scope, each a named follow-up:** VPS provisioning + hardening;
real domain, Cloudflare DNS/CDN, wildcard DNS-01 issuance; backups
(pgBackRest / WAL archiving, tested restores per blueprint §8.3); CI image
build/publish (tag-by-SHA per §8.2); observability stack (§8.4); the OTP
provider (production console login stays impossible — known, deliberate);
multi-replica storefront purge fan-out; image slimming
(`output: "standalone"`, pruned worker).
