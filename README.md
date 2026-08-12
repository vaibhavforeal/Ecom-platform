# Commerce Platform

A multi-tenant commerce platform — an engine that runs many independent online stores, each with its own catalog, customers, domain, branding, tax identity and payment account.

- **Architecture & roadmap:** [`PLATFORM_BLUEPRINT.md`](./PLATFORM_BLUEPRINT.md)
- **Status:** Phase 0 (foundations) complete and verified. Phase 1 next.

---

## The one rule

**No tenant may be hardcoded anywhere.** Not a GSTIN, courier account, theme, free-shipping threshold, invoice prefix, or domain. A store is a row in `tenants`.

Honour that and opening the platform to other merchants is a signup form. Break it and it is a rewrite. The isolation suite exists to make the rule enforceable rather than merely remembered.

---

## Quick start

Requires Node 22+, pnpm 9+, and Docker.

```bash
cp .env.example .env
pnpm install
pnpm infra:up          # postgres + pgbouncer + redis
pnpm db:generate       # generate the initial migration from the schema
pnpm db:migrate        # apply schema, then RLS policies and grants
pnpm db:seed           # two demo tenants on two hostnames
pnpm dev               # storefront :3000 · console :3001 · worker
```

Then:

| URL | What |
| :--- | :--- |
| http://acme.localhost:3000 | Demo tenant 1 storefront |
| http://globex.localhost:3000 | Demo tenant 2 storefront |
| http://localhost:3001/login | Merchant console |

`*.localhost` resolves to `127.0.0.1` in Chrome, Firefox and Safari, so both storefronts work with no hosts-file edit. Any unrecognised hostname returns 404 — there is deliberately no default tenant.

Seeding creates tenants but no users. To sign in, add yourself as staff:

```sql
-- psql postgres://app_migrator:app_migrator_dev_pw@localhost:5442/platform
INSERT INTO users (id, phone_e164, name)
VALUES (gen_random_uuid(), '+919876543210', 'Your Name');

INSERT INTO tenant_members (tenant_id, user_id, role, accepted_at)
SELECT t.id, u.id, 'owner', now()
FROM tenants t, users u
WHERE t.slug = 'acme' AND u.phone_e164 = '+919876543210';
```

The OTP is printed to the terminal running `pnpm dev` — the console provider refuses to start in production.

> **Ports.** Postgres `5442`, PgBouncer `6442`, Redis `6389` — deliberately off the defaults so the stack does not collide with another local database.

---

## Layout

```
apps/
  storefront/   Next.js — public, multi-domain, SEO-critical
  console/      Next.js — merchant admin + API routes
  worker/       BullMQ consumers
packages/
  core/         domain logic — identity, tenancy, audit, logistics, crypto
  db/           schema, migrations, RLS, withTenant()
  integrations/ carrier adapters + registry
  config/       shared eslint + tsconfig
infra/
  docker/       dev compose, postgres init, pgbouncer
  caddy/        production proxy with on-demand TLS
```

Workspace packages ship TypeScript source with no build step — Next transpiles them, `tsx` runs the worker, Vitest reads them directly.

---

## Commands

| Command | Does |
| :--- | :--- |
| `pnpm dev` | All three apps with hot reload |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm lint` | ESLint, including the import-boundary rules |
| `pnpm test` | Unit tests (no database) |
| `pnpm test:integration` | **Tenant isolation suite** — needs Postgres |
| `pnpm db:generate` | Generate a migration after a schema change |
| `pnpm db:migrate` | Apply migrations, then re-derive RLS and grants |
| `pnpm infra:nuke` | Destroy volumes and start clean |

---

## Working on this safely

**Adding a table.** Give it `tenant_id` and run `pnpm db:migrate`. Policies are generated from the schema, so isolation is automatic. If the table is genuinely control-plane data — queried before tenant context exists, like hostname resolution or login — add it to `PLATFORM_TABLES` in `packages/db/src/rls.ts` *with a written justification*. CI fails on any table that is neither.

**Querying.** `withTenant(tenantId, tx => …)` for tenant data, `withPlatform(tx => …)` for control-plane reads. The raw client is unexported and ESLint blocks importing it. `withPlatform` does not elevate privileges — it is not an escape hatch out of isolation.

**Caching.** Every Redis key goes through `tenantKey()`. An unprefixed key is a cross-tenant leak RLS cannot catch, because Redis has no idea what a tenant is.

**Background jobs.** Every payload carries `tenantId`; every handler opens with `withTenant`. The `TenantJob<T>` type makes the alternative a compile error.

**Adding a carrier.** Add the code to `CARRIER_CODES` in `packages/db/src/schema/enums.ts`, define the adapter in `packages/integrations/src/carriers/`, and register it. Nothing in orders, checkout or the console changes. Unwired transport methods throw rather than returning a plausible AWB — a stub that "succeeds" marks an order shipped with no parcel behind it.

**Third-party credentials.** Always `sealCredentials()` / `openCredentials()` with the `(tenant, carrier)` AAD. Never store, log or return a merchant's carrier or gateway keys in plaintext.

**Permissions.** Check permissions, never roles. `if (role === 'owner')` is how you end up unable to offer custom roles later without touching every call site.

**Migrations.** Expand only. Add a column, deploy code writing both, backfill, deploy code reading the new one, drop the old one in a later release. Never a destructive migration in the same deploy as the code that depends on it — that is what makes rollback possible, and you will need rollback.

---

## Phase 0 exit criteria

- [x] Two tenants on two hostnames, provably unable to see each other's data
- [x] RLS derived from the schema, `FORCE` enabled, app role holds no `BYPASSRLS`
- [x] Policies fail closed via `NULLIF` — no context, no rows, no error
- [x] `withTenant` / `withPlatform` as the only data access paths
- [x] Hostname → tenant resolution with negative caching and no default tenant
- [x] On-demand TLS gated on verified domains
- [x] Phone OTP auth, server-side sessions, role permissions, append-only audit log
- [x] Isolation suite wired as a required CI check

## Also built

- [x] Multi-carrier logistics framework — adapter contract, registry, capability declarations
- [x] Nine providers declared: Shiprocket, Shipmozo, NimbusPost (aggregators); Ekart, Delhivery, Blue Dart, XpressBees, DTDC, Ecom Express (direct)
- [x] Status/NDR normalisation with out-of-order and duplicate-event defences
- [x] Carrier selection engine — cheapest / fastest / balanced / preferred, with RTO risk pricing
- [x] Billable weight (volumetric + slab) and weight-discrepancy dispute detection
- [x] Envelope encryption for tenant-held third-party credentials
- [x] Fully working in-memory reference carrier for developing fulfilment against

Vendor HTTP transport is deliberately not written — it needs live credentials and each vendor's current API docs. See Phase 3 in the blueprint.

Next: **Phase 1 — Catalog & Storefront.** See the roadmap in the blueprint.
