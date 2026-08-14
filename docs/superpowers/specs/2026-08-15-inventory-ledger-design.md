# Design — Inventory ledger (Phase 2, task 1)

**Date:** 2026-08-15
**Status:** Approved by the owner (scope, approach, and all four design sections)

Opens Phase 2 (Commerce Core) with blueprint §4.5: an append-only
`stock_movements` ledger as the source of truth for stock, a `stock_levels`
projection for fast reads, opt-in tracking per variant, a console surface for
adjustments and low-stock visibility, and a minimal sold-out state on the
storefront PDP. Never a mutable counter: when a merchant asks "why does this
say 3 when I have 5?", the answer is a timestamped list of movements.

Scope decisions made by the owner at session start:

- **Default location only.** A `locations` table exists from day one and every
  movement records one — retrofitting a NOT NULL column onto an append-only
  ledger later means backfill guesswork — but the only row is an
  auto-provisioned default per tenant. No location CRUD until POS (Phase 5).
- **Tracking is opt-in per variant** (`tracks_inventory`, default off).
  Untracked variants behave exactly as today: always sellable, no stock shown.
  Existing catalogs are untouched — nothing suddenly reads "sold out". This is
  Shopify's model. Rejected: mandatory tracking (forces merchants who never
  count stock to lie); tenant-level toggle (too coarse).
- **Console surface: product page + a dedicated `/inventory` page.** Rejected:
  API-only (the search_indexing no-writer trap all over again).
- **Storefront: minimal PDP sold-out state.** The only customer-visible effect
  until cart/checkout exists, and it gives the task a live-verifiable exit
  criterion. Rejected: no storefront change (nothing observable to verify).
- **CSV carries the `variant_tracks_inventory` flag, not quantity.** Bulk
  opening balances (absolute-quantity-to-delta semantics) are the designed
  follow-up task, not part of this one.
- **Projection strategy: same-transaction upsert in the domain write**
  (approach A). Rejected: a Postgres trigger (logic leaves TypeScript,
  hand-managed DDL, owner-privilege semantics under RLS — and the
  `search_vector` precedent for db-maintained derivations is a *generated
  column*, an option that does not exist for cross-table aggregation);
  computing SUM on every read (no DB-level oversell guard, contradicts §4.5).

---

## Facts the design rests on

Verified against the tree at `2228879` (paths cited so the plan can re-verify):

- `product_variants` (`packages/db/src/schema/catalog.ts:374-432`) has
  `lowStockAt` (`:399`, default 2) and **no quantity column**;
  `apps/console/src/app/products/ProductForm.tsx:582-583` explicitly defers
  stock to this task, as does `apps/storefront/src/lib/seo.ts:86-89` for
  JSON-LD `Offer.availability`.
- Permissions `inventory:read` / `inventory:write` already exist
  (`packages/core/src/identity/permissions.ts:19-20`).
- RLS is derived, not hand-written (`packages/db/src/rls.ts`): a new table
  with `tenant_id` gets FORCE RLS + policy automatically on every migrate
  (`scripts/migrate.ts` re-applies), and append-only is enforced by grants —
  the `appendOnly` set at `rls.ts:144` gives `audit_log` SELECT+INSERT only.
  `stock_movements` joins that set.
- The console write pipeline (`apps/console/src/lib/catalog-routes.ts`,
  `handleCatalogWrite`) already takes a permission override
  (`assertCan(actor, opts.permission ?? "catalog:write")`); audit happens
  inside the domain write via `recordAudit(tx, tenantId, entry)`
  (`packages/core/src/audit/index.ts`).
- Module pattern: pure barrel + `/server` barrel
  (`packages/core/src/catalog/{index,server}.ts`), subpaths declared in
  `packages/core/package.json` exports. Inventory adds `./inventory` and
  `./inventory/server`.
- Tenant safety: all writes inside `withTenant`
  (`packages/db/src/tenant-scope.ts:45`); every id a payload names is checked
  with an explicit SELECT (`assertVisible`, `packages/core/src/catalog/writes.ts`)
  because a FK does not enforce tenancy.
- Cache purge: tenant-prefixed product tags, purged **after commit**,
  fail-soft (`packages/core/src/catalog/purge.ts`, exported via
  `catalog/server`). A purge issued inside the transaction can re-cache the
  pre-commit row — trap already documented.
- Migrations live in `packages/db/drizzle/NNNN_*.sql` (drizzle-kit generated,
  hand-editable); the migrator runs all pending migrations in ONE transaction,
  so no `CREATE INDEX CONCURRENTLY`.
- CSV: blank states nothing — the `variant_active` lesson. The importer only
  applies fields the file carries; the dry-run preview names changed fields
  via `ImportProductResult.changes`.
- Storefront tests that assert "the visitor now sees X" must run through
  `runDynamicRender` (`apps/storefront/tests/next-cache-harness.ts`).
- Integration suites clean up after themselves (tenants → users → plans) and
  `test:integration` is serialized db → core → apps via turbo `dependsOn`.

---

## 1. Schema — `packages/db/src/schema/inventory.ts` (new)

All three tables carry `tenant_id` and are NOT in `PLATFORM_TABLES`, so RLS
policies apply automatically.

**`locations`** — `id` uuid PK (uuidv7), `tenant_id` → tenants (cascade),
`name` text NOT NULL default `'Default'`, `is_default` boolean NOT NULL
default false, `created_at`/`updated_at`. Partial unique index on
`(tenant_id) WHERE is_default` — exactly one default per tenant. No soft
delete, no address fields, no CRUD: Phase 5's concern.

**`stock_movements`** — append-only:

- `id` uuid PK (uuidv7), `tenant_id` → tenants (cascade),
  `variant_id` → product_variants (**no cascade** — a hard variant delete
  must not erase ledger history; variants are soft-deleted in practice),
  `location_id` → locations (no cascade).
- `delta` integer NOT NULL, `CHECK (delta <> 0)`.
- `reason` text NOT NULL, CHECK against `STOCK_MOVEMENT_REASONS` in
  `schema/enums.ts` — **`'opening_balance' | 'adjustment'`** only. Order/RTO
  reasons arrive as migrations with their phases; a new reason being a
  migration is deliberate and explicit.
- `note` text nullable — merchant free text; automated movements (future
  sales) carry references instead.
- `reference_type` text / `reference_id` uuid, both nullable — for orders and
  RTO later. Unused this task.
- `idempotency_key` text nullable, partial unique index on
  `(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.
- `created_at` timestamptz default now, `created_by_user_id` → users.
- **No `updated_at`, no `deleted_at`.** App-role grants: SELECT + INSERT only
  (added to the `appendOnly` set in `rls.ts`).
- Index `(tenant_id, variant_id, created_at)` for history reads.

**`stock_levels`** — the projection:

- PK `(tenant_id, variant_id, location_id)`; `variant_id` → product_variants
  (cascade — the projection is derivable), `location_id` → locations.
- `on_hand` integer NOT NULL default 0, **`CHECK (on_hand >= 0)`** — the
  oversell guard. Concurrent movements serialize on this row's lock; the
  loser of a last-unit race gets a constraint violation, not silence.
- `updated_at` timestamptz. **No `reserved` column** — that arrives with the
  reservations task, when `available` starts meaning `on_hand − reserved`.
  Until then `available = on_hand` (summed across locations; there is one).

**`product_variants.tracks_inventory`** — boolean NOT NULL default false, in
`catalog.ts`. Rides the existing catalog variant write path like `isActive`,
so product form, CSV, dry-run preview, and product audit before/after all get
it through machinery that already exists.

One drizzle-kit migration for all of the above.

## 2. Domain module — `packages/core/src/inventory/`

**`index.ts` (pure, client-safe):** `StockMovementReason`,
`isLowStock(onHand, lowStockAt)`, movement input/result types. Nothing else.

**`server.ts`:**

- `ensureDefaultLocation(tx, tenantId)` — get-or-create inside the caller's
  transaction; on a unique-index race, re-select.
- `recordMovement(ctx: WriteContext, input: { variantId, delta, note?,
  idempotencyKey? })` — the single write door, one `withTenant` transaction:
  1. `assertVisible` the variant (tenant safety) and load it; reject
     untracked variants (`UntrackedVariantError` → 422 with a hint to enable
     tracking).
  2. Idempotency: if the key already exists, fetch and return the existing
     movement — replay is success.
  3. Reason chosen automatically: first movement for the variant →
     `opening_balance`, else `adjustment`. Not merchant-selected.
  4. INSERT the ledger row; upsert the projection — INSERT the delta as the
     row's `on_hand`, `ON CONFLICT (tenant_id, variant_id, location_id) DO
     UPDATE SET on_hand = stock_levels.on_hand + EXCLUDED.on_hand,
     updated_at = now()`.
  5. A `23514` on the CHECK → `InsufficientStockError` → 422 naming current
     on-hand and the refused result. The transaction rolls back whole: no
     ledger row without its projection update, ever.
  6. `recordAudit(tx, …, "inventory.adjusted")` with before/after on-hand.
  - **After commit:** purge the product's tenant-prefixed tag via the existing
    helper. Fail-soft. Never inside the transaction.
- Reads: `getStockLevels(tx, variantIds)` (per-variant on-hand for console
  product queries), `listInventory(tx, { lowStockOnly?, cursor? })` (tracked,
  non-deleted variants joined to levels and `lowStockAt`; keyset-paginated),
  `getMovements(tx, variantId, cursor?)` (history, newest first),
  `reconcileStockLevels(tx)` (SUM(deltas) vs projection per variant/location;
  returns mismatches — diagnostic only, backs the tests and the audit answer).
- Validation: `delta` a nonzero integer, `|delta| ≤ 1_000_000`; `note`
  required non-empty at the route for every merchant-initiated movement (the
  audit answer quality depends on it) — the column stays nullable for future
  automated movements, which carry references instead.

Enabling tracking writes no movement — a tracked variant with no ledger rows
is at 0 and reads "out of stock" until an opening balance is set; the product
form copy says so. Disabling tracking retains all history and returns the
variant to always-sellable.

## 3. Console

**API** (the `handleCatalogWrite` pipeline with explicit permissions):

- `POST /api/inventory/movements` — `inventory:write`. Body
  `{ variantId, delta, note, idempotencyKey? }`; the client sends a generated
  idempotency key per dialog submission (double-click/retry guard). 201 with
  the movement and the new on-hand.
- `GET /api/inventory` — `inventory:read`. Tracked variants with levels;
  `?lowStock=true`; cursor pagination.
- `GET /api/inventory/movements?variantId=` — `inventory:read`. History.
- Error contract unchanged: 401/403/413/400/422 with `requestId`, field-level
  zod issues.

**UI:**

- **`/inventory` page** — gated on `inventory:read` (nav chip likewise):
  table of tracked variants (product title, SKU, options, on-hand, low-stock
  badge where `on_hand ≤ lowStockAt`), low-stock filter, per-row Adjust
  button. Adjust dialog: signed quantity, required note, live preview of the
  resulting level ("3 → 5"), disabled without `inventory:write`.
- **Product edit page** — per-variant "Track inventory" toggle (rides the
  product PUT); when tracked, the variant row shows on-hand, the same adjust
  dialog, and a movement history view (timestamp, delta, reason, note, who).

## 4. Storefront

- `getCachedProduct` gains per-variant availability: for tracked variants,
  `SUM(on_hand)` across locations (one, today); untracked → available,
  unchanged. Computed at cache fill; the movement write's purge keeps it
  current — a console adjustment is visible on the PDP within a second, the
  same property as every other write.
- PDP: a tracked variant at 0 renders greyed/disabled ("M — out of stock");
  a product whose relevant variant is tracked-and-zero flips JSON-LD
  `Offer.availability` to `OutOfStock` — the change `seo.ts:86` anticipates.

## 5. CSV

- Export writes `variant_tracks_inventory` as `true`/`false`; import parses
  it with blank-states-nothing semantics — a blank cell leaves the stored
  flag alone, asserted in the test with the flag ON so a silent default-off
  fails it.
- The dry-run preview's `changes` list names the flip
  (`"tracks_inventory (enabled)"` style). No quantity column.

## 6. Testing, gate, docs

**Unit:** reason auto-selection, `isLowStock` boundaries, movement input
validation.

**Integration** (standard harnesses, tracked-id cleanup tenants → users →
plans; new tables also cleaned):

1. Record → level reads back; a mixed sequence sums; `reconcileStockLevels`
   returns no mismatches afterwards.
2. Adjustment below zero → 422, **no ledger row** (atomicity).
3. Untracked variant → 422; another tenant's variantId → not-found
   (`assertVisible` path); RLS isolation covers the three new tables (the
   isolation suite derives from the schema — verify they appear).
4. `UPDATE`/`DELETE` on `stock_movements` as `app_user` → permission denied
   (same shape as the audit_log test).
5. **Concurrency:** two parallel `withTenant` transactions decrementing the
   last unit — exactly one succeeds. This is the test that would catch a
   refactor to read-then-write.
6. Idempotency: same key twice → one ledger row, same response.
7. Console routes: 401 / 403 (role without `inventory:write`) / 422 shapes /
   audit row / purge fired after commit and not on failure.
8. CSV round-trip of the flag; blank leaves it untouched.
9. Storefront: availability in the PDP query; sold-out via `runDynamicRender`;
   JSON-LD flips.

**Gate:** full matrix (lint, typecheck, build, unit, integration), counts
reconciled against commits in PROJECT_STATUS.

**Live verification** (production builds, both apps): enable tracking on a
seeded variant → opening balance 5 via the console → PDP in stock → adjust to
0 → PDP sold out **immediately** (no TTL wait) → JSON-LD checked → history
shows both movements with notes and actor.

**Docs:** PROJECT_STATUS gains the wave's verified block and flips the stock
open-item to "ledger shipped; reservations and CSV quantity pending";
`tasks/lessons.md` untouched unless something earns an entry.

---

## Out of scope

- **Reservations** (`stock_reservations`, the `reserved` column, checkout
  holds) — next Phase 2 task; `available` is `on_hand` until then.
- **CSV quantity / bulk opening balances** — designed follow-up.
- **Location CRUD, per-location views, transfers** — Phase 5 (POS).
- **Backorder/oversell allowance** — would relax the `on_hand >= 0` CHECK;
  decide when checkout exists.
- **Low-stock notifications** — Phase 4 (messaging); the badge is the whole
  of it today.
- **Order/RTO movement reasons** — arrive with the order state machine.
