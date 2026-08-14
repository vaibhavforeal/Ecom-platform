# Design — Search-indexing settings UI

**Date:** 2026-08-14
**Status:** Approved by the owner (scope, approach, and all four design sections)

Closes the last ⚠️ row in Phase 1: `tenants.search_indexing`
(`auto` | `indexed` | `noindex`) has a complete, tested read side —
`isSearchIndexable`, `robots.txt`, page metadata — but nothing writes the
column. This builds the writer: a console **/settings** page whose only
control today is search indexing, structured so later settings have a home.

Scope decisions made by the owner at session start:

- A **general `/settings` page with one setting on it** — not a minimal
  one-off control, not a multi-tab scaffold.
- **Domain write in `packages/core`** with a dedicated console route and page —
  not a route-local write. Mirrors the catalog architecture: write + audit +
  invalidation are one domain function, apps stay thin.
- Reusing the key-value `store_settings` table was rejected: the column
  deliberately lives on `tenants` (see `docs/superpowers/plans/phase1-completion.md`),
  because the host resolver and `isSearchIndexable` read it there.

---

## Facts the design rests on

Verified against the tree at `3eb6991` (paths cited so the plan can re-verify):

- Column: `packages/db/src/schema/tenancy.ts:68` — plain `text` with a CHECK
  against `SEARCH_INDEXING_MODES` (`packages/db/src/schema/enums.ts:108`),
  default `'auto'`, NOT NULL. **`tenants.updatedAt` has no `$onUpdate`** — an
  UPDATE must set it explicitly.
- `tenants` is control-plane: in the `PLATFORM_TABLES` allowlist
  (`packages/db/src/rls.ts:29`), RLS actively disabled every migration. The
  same unprivileged `app_user` role writes it. **The UPDATE's
  `WHERE id = actor.tenantId` is the only tenant isolation on this table.**
- `audit_log` IS RLS-protected (`WITH CHECK tenant_id = app.tenant_id`), so an
  audit row requires tenant context — hence the update and the audit share one
  `withTenant` transaction (`tenants` ignores the GUC, so this works).
- Resolver precedence (`packages/core/src/tenancy/indexing.ts:18`):
  `suspended`/`churned` → never indexed; `indexed` → indexed (even on trial);
  `noindex` → not indexed; `auto` → indexed iff `active`. Truth-table tested.
- The tenant row is cached in **Redis**, not Next tags:
  `resolveTenantByHost` (`packages/core/src/tenancy/resolve.ts:47`) caches
  `p:host:<hostname>` for 300 s. `invalidateHostCache(hosts, tenantId)`
  (resolve.ts:96) exists, and console + storefront share the Redis singleton,
  so the console calls it directly. The Next-tag purge endpoint does not cover
  the tenant row and rejects non-`t:<tenantId>:` tags anyway.
- Permissions `settings:read` / `settings:write` already exist
  (`packages/core/src/identity/permissions.ts:31`): owner and manager hold
  write; catalog_manager and order_processor hold read only.
- Console mutation style: client component `fetch` → route handler →
  `getActorOrThrow` → `assertCan` → bounded body → zod → domain write, errors
  as `{ error: { code, message, details: { issues } }, requestId }` with
  field-level 422s (`apps/console/src/lib/catalog-routes.ts:62`). No server
  actions, by explicit prior decision (`ProductForm.tsx:23`).
- `robots.txt` is served with `s-maxage=3600, stale-while-revalidate=86400` —
  a CDN may hold the old file for up to an hour after the flip. Nothing in the
  repo purges a CDN; the UI copy states this honestly.

---

## 1. Domain write — `packages/core/src/tenancy/settings.ts` (new)

`updateSearchIndexing(ctx, mode)`:

- `ctx`: `{ tenantId, actorUserId, ip, userAgent, requestId }` — the same
  shape as the catalog `WriteContext`; `tenantId` comes from the session,
  never from a payload.
- `mode` is validated against `SEARCH_INDEXING_MODES` (defence in depth; the
  route validates too).
- One `withTenant(ctx.tenantId, tx => …)` transaction:
  1. SELECT the current row — before-snapshot and no-op detection.
  2. **No-op**: stored value already equals `mode` → return without updating,
     auditing, or invalidating (same principle as "a no-op import does not
     purge").
  3. `UPDATE tenants SET search_indexing = mode, updated_at = now()
     WHERE id = ctx.tenantId`.
  4. `recordAudit(tx, ctx.tenantId, …)` — action
     `"settings.search_indexing_changed"`, `actorType: "staff"`, before/after
     values, ip/userAgent/requestId.
- **After the transaction commits**:
  `invalidateHostCache(await domainsForTenant(ctx.tenantId), ctx.tenantId)`.
  Fail-soft — an invalidation failure is logged and never fails the write;
  staleness is then bounded by the 300 s Redis TTL.
- Exported from the tenancy server surface alongside `resolveTenantByHost`
  (it touches db + Redis, so it must not enter any client-safe barrel).

## 2. Console API route — `PUT /api/settings`

- Body: `{ searchIndexing: z.enum(SEARCH_INDEXING_MODES) }` (enum imported
  from `@platform/db`, mirroring the DB CHECK).
- Pipeline identical to `handleCatalogWrite`, gated on
  `assertCan(actor, "settings:write")`. Implemented by **adding a permission
  parameter to the existing handler** (default `catalog:write`, so current
  callers are untouched) rather than duplicating the pipeline.
- Error contract unchanged: 401 unauthenticated, 403 without the permission,
  413 over the body cap, 400 `invalid_json`, 422 `invalid_payload` with
  field-level issues; every response carries `requestId`.
- Success: 200 with the new value.
- No GET route — the page reads the row server-side, as the dashboard already
  does.

## 3. Console UI

- **`/settings` page** (server component): `requireActor()`; gated on
  `settings:read` the same way `/products` is gated on `catalog:read`; reads
  the tenant via `withPlatform`; computes `isSearchIndexable(tenant)`
  **server-side**; renders breadcrumbs + a panel, passing
  `{ current mode, status, indexable, canWrite }` as props to the form.
- **`SearchIndexingForm`** (client component, `fetch` PUT — no server
  actions): a three-option radio group with merchant-facing copy:
  - *Automatic* — "indexed once the store is active";
  - *Always indexed* — "search engines may index even during trial";
  - *Hidden* — "ask search engines not to index".
  Above it, the effective state: "Search engines are currently allowed / not
  allowed to index this store." If status is `suspended`/`churned`, a note
  that the platform override wins regardless of the setting.
- Save → success message + `router.refresh()` (re-renders the server-computed
  effective state); errors via the existing `FieldIssues` pattern; controls
  disabled without `settings:write` (read-only for catalog_manager /
  order_processor).
- **Dashboard**: a Settings chip in the existing toolbar nav, gated by
  `can(actor, "settings:read")`.
- Copy states the CDN reality: the storefront updates right away, but
  `robots.txt` may be cached by a CDN for up to an hour.

## 4. Testing, gate, docs

New `apps/console/tests/settings.integration.test.ts` on the standard harness
(mocked `next/headers` cookie, real DB via the migrator connection, tracked-id
cleanup tenants → users → plans, a `Set` per id kind):

1. Unauthenticated → 401.
2. Role with only `settings:read` (catalog_manager) → 403.
3. Invalid value → 422 with issue path `searchIndexing`.
4. Happy path → 200; column updated; `updated_at` bumped; audit row with
   action `settings.search_indexing_changed` and correct before/after.
5. Host-cache invalidation: warm the Redis host cache via
   `resolveTenantByHost`, flip the setting through the route, assert the
   resolver now serves the fresh value (not the 300 s-cached one).
6. No-op write → 200, no audit row, cache untouched.

Gate: full matrix (lint, typecheck, build, unit, integration) plus a live
HTTP pass — flip the setting in the console and watch `robots.txt` and the
meta robots tag change on the storefront.

Docs: PROJECT_STATUS's Phase 1 ⚠️ row flips to ✅; PHASE1_FOLLOWUPS'
"`tenants.search_indexing` has no writer" known-limitation moves to fixed.

No page-component tests — the repo has no precedent, and the route + domain
tests plus the live pass cover the behaviour.

---

## Out of scope

- Any second setting (store name, domains, payments) — the page merely gives
  them a home.
- CDN purge for `robots.txt` — deployment concern, no CDN exists in the repo.
- Changing `isSearchIndexable`, the column, or its CHECK — read side is done
  and tested.
- Signup/plan changes to `status` — the override interaction is rendered, not
  altered.
