# Inventory Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build blueprint §4.5 — an append-only `stock_movements` ledger as the source of truth for stock, a `stock_levels` projection kept true in the same transaction, opt-in per-variant tracking, a console adjust/history surface, and a minimal sold-out state on the storefront PDP.

**Architecture:** Three new data-plane tables (`locations`, `stock_movements`, `stock_levels`) get RLS automatically; `stock_movements` joins `audit_log` in the append-only grant set. A single write door — `recordMovement` in the new `@platform/core/inventory/server` — inserts the ledger row and upserts the projection atomically inside `withTenant`; `CHECK (on_hand >= 0)` on the projection is the concurrency-proof oversell guard. `product_variants.tracks_inventory` rides the existing catalog write path (form, zod, CSV, audit) like `isActive`. Spec: `docs/superpowers/specs/2026-08-15-inventory-ledger-design.md`.

**Tech Stack:** Next 16.3.0 (App Router, Turbopack), Drizzle + postgres.js, zod 3, vitest integration tests against real Postgres.

## Global Constraints

- `pnpm` is NOT on PATH in a plain shell. Run `export PATH="$HOME/.pnpm-shim:$PATH"` first in every shell. Run all pnpm commands from the repo root `D:\Software Ideas\Ecommerce Website`.
- Ports are non-default on purpose: Postgres `5442`, PgBouncer `6442`, Redis `6389`. Port 3000 is taken — storefront serves on `3010`, console on `3001`. Do not "fix" any of this.
- Integration tests need Docker up: `pnpm infra:up`, then `pnpm db:migrate`. `pnpm test:integration` is serialized by turbo — always run from the root.
- **Baseline counts before this plan:** 325 unit tests, 191 integration (console 107, core 25, db 32, storefront 16, worker 11). Record ACTUAL numbers at every gate; never copy expectations into docs unverified.
- Relative imports are extensionless repo-wide. No new npm dependencies.
- `sql`, `and`, `eq`, `inArray`, `isNull`, `asc`, `desc` etc. are re-exported by `@platform/db` (`packages/db/src/index.ts:20`) — core has no direct drizzle-orm dependency; always import operators from `@platform/db`.
- Error contract (already implemented in `handleCatalogWrite` — do not reinvent): `{ error: { code, message, details?: { issues: [{ path, message }] } }, requestId }`; 401 unauthenticated, 403 forbidden, 413 over 1 MiB, 400 `invalid_json`, 422 `invalid_payload`.
- The tenant id comes from the SESSION only. Never accept a tenantId in a body.
- Purges are issued AFTER the transaction commits, never inside it, and never throw (`packages/core/src/catalog/purge.ts`).
- Audit rows are written INSIDE the transaction via `recordAudit(tx, tenantId, entry)` (`packages/core/src/audit/index.ts:36`).
- Integration suites delete what they create, in order tenants → users → plans, tracking ids in `Set`s. Two consecutive runs must leave row counts unchanged.
- Permissions `inventory:read` / `inventory:write` already exist (`packages/core/src/identity/permissions.ts:19-20`). Roles: owner/manager/catalog_manager hold `inventory:write`; **order_processor holds `inventory:read` only** — use it for 403 tests.
- Movement cap: `|delta| ≤ 1_000_000` (`STOCK_ADJUSTMENT_MAX`). Audit action name: `inventory.adjusted`. Reasons: `opening_balance` (variant's first movement, chosen automatically) | `adjustment`.
- The `@platform/core` pure barrels must not import `@platform/db` or anything server-only; db-touching code goes behind `/server` subpaths.

---

### Task 1: Schema, migration, RLS grants, isolation coverage

Three new tables + one new variant column + the append-only grant + isolation-suite fixtures. Also amends one spec paragraph (see Step 1 rationale).

**Files:**
- Modify: `packages/db/src/schema/enums.ts` (append at end)
- Create: `packages/db/src/schema/inventory.ts`
- Modify: `packages/db/src/schema/index.ts` (one export line)
- Modify: `packages/db/src/schema/catalog.ts:399` (one column after `lowStockAt`)
- Modify: `packages/db/src/rls.ts:144` (append-only set)
- Modify: `packages/db/tests/isolation.test.ts` (fixtures + append-only loop)
- Modify: `docs/superpowers/specs/2026-08-15-inventory-ledger-design.md` (schema section amendment)
- Migration: generated `packages/db/drizzle/0005_*.sql`

**Interfaces:**
- Consumes: existing schema helpers (`sqlLiteralList`, table patterns in `catalog.ts`).
- Produces: Drizzle tables `locations`, `stockMovements`, `stockLevels` and column `productVariants.tracksInventory` (all exported from `@platform/db`); `STOCK_MOVEMENT_REASONS` / type `StockMovementReason` from `@platform/db`. Task 2 imports all of these.

- [ ] **Step 1: Amend the spec (FK-less ledger columns)**

Planning found a defect in the approved schema: RESTRICT/NO-ACTION FKs from `stock_movements` to `product_variants`/`locations` would make **tenant deletion fail** — `DELETE FROM tenants` cascades to variants and locations, and PostgreSQL's cascade order does not guarantee the movements are gone first, so the NO ACTION check can fire mid-cascade. Every integration suite's cleanup deletes tenants; all of them would break.

The fix follows the `audit_log` precedent: history tables reference by bare uuid, integrity is enforced at write time (`assertVisible`-style SELECT inside `recordMovement`). In the spec's Section 1, replace the `variant_id` / `location_id` FK sentences in the `stock_movements` bullet with:

```
- `variant_id` uuid NOT NULL and `location_id` uuid NOT NULL — bare uuids,
  NO foreign keys, the `audit_log.entity_id` precedent: a RESTRICT FK here
  would make tenant deletion fail mid-cascade (movements must outlive
  nothing, but Postgres cascade order is unspecified), and a CASCADE FK
  would let a stray hard variant delete silently erase ledger history.
  Write-time integrity comes from the visibility SELECT inside
  `recordMovement`.
```

- [ ] **Step 2: Add the reason enum**

Append to `packages/db/src/schema/enums.ts`:

```ts
/**
 * Why stock moved. Deliberately minimal: order/RTO/POS reasons arrive as
 * migrations with their phases, and a new reason being a migration is a
 * feature — the CHECK constraint is the single source of truth.
 * `opening_balance` is chosen automatically for a variant's first
 * movement; everything merchant-initiated after that is `adjustment`.
 */
export const STOCK_MOVEMENT_REASONS = ["opening_balance", "adjustment"] as const;
export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];
```

- [ ] **Step 3: Create `packages/db/src/schema/inventory.ts`**

```ts
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { STOCK_MOVEMENT_REASONS, sqlLiteralList } from "./enums";
import type { StockMovementReason } from "./enums";
import { productVariants } from "./catalog";
import { tenants } from "./tenancy";
import { users } from "./identity";

/**
 * DATA PLANE — RLS-protected automatically (see rls.ts).
 *
 * The inventory ledger, blueprint §4.5. `stock_movements` is the source
 * of truth and is append-only BY GRANT (rls.ts gives the app role
 * SELECT + INSERT only); `stock_levels` is a projection kept true in the
 * same transaction by `@platform/core/inventory/server`, and its
 * CHECK (on_hand >= 0) is the oversell guard — two concurrent sales of
 * the last unit serialize on the row lock and the loser gets a
 * constraint violation, not silence.
 */

/**
 * Where stock sits. One auto-provisioned default per tenant until POS
 * (Phase 5) brings real multi-location; the column exists on the ledger
 * from day one because retrofitting NOT NULL onto append-only history
 * means backfill guesswork.
 */
export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: text("name").notNull().default("Default"),
    isDefault: boolean("is_default").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Exactly one default per tenant. `ensureDefaultLocation` relies on
    // this to make its get-or-create race-safe.
    uniqueIndex("locations_one_default_key").on(t.tenantId).where(sql`is_default`),
  ],
);

/**
 * The ledger. Append-only: no updated_at, no deleted_at, and the app
 * role has no UPDATE/DELETE grant.
 *
 * `variant_id` and `location_id` are bare uuids with NO foreign key —
 * the audit_log.entity_id precedent. A RESTRICT FK would make tenant
 * deletion fail mid-cascade (cascade order is unspecified), and CASCADE
 * would let a stray hard variant delete silently erase history. The
 * visibility SELECT in recordMovement is the write-time integrity check.
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    variantId: uuid("variant_id").notNull(),
    locationId: uuid("location_id").notNull(),

    /** +50 restock, -1 sale, +1 RTO. Never zero. */
    delta: integer("delta").notNull(),
    reason: text("reason").$type<StockMovementReason>().notNull(),

    /** Merchant free text — what answers "why does this say 3?". */
    note: text("note"),

    /** For future automated movements (orders, RTO). Unused this task. */
    referenceType: text("reference_type"),
    referenceId: uuid("reference_id"),

    /** Client-generated; makes a double-clicked adjust idempotent. */
    idempotencyKey: text("idempotency_key"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
  },
  (t) => [
    uniqueIndex("stock_movements_tenant_idem_key")
      .on(t.tenantId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    index("stock_movements_variant_idx").on(t.tenantId, t.variantId, t.createdAt),
    check("stock_movements_delta_check", sql`${t.delta} <> 0`),
    check(
      "stock_movements_reason_check",
      sql`${t.reason} IN (${sql.raw(sqlLiteralList(STOCK_MOVEMENT_REASONS))})`,
    ),
  ],
);

/**
 * The projection: available-to-display, always reconcilable against
 * SUM(stock_movements.delta). No `reserved` column yet — that arrives
 * with the reservations task, when `available` starts meaning
 * on_hand − reserved.
 */
export const stockLevels = pgTable(
  "stock_levels",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),

    onHand: integer("on_hand").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.variantId, t.locationId] }),
    // The oversell guard. recordMovement maps a violation to a 422.
    check("stock_levels_on_hand_check", sql`${t.onHand} >= 0`),
  ],
);
```

(The projection's FKs CASCADE deliberately — it is derivable, so nothing is lost.)

- [ ] **Step 4: Wire the schema in**

In `packages/db/src/schema/index.ts` append:

```ts
export * from "./inventory";
```

In `packages/db/src/schema/catalog.ts`, directly under `lowStockAt` (line 399), add:

```ts
    /**
     * Opt-in inventory tracking (blueprint §4.5). OFF by default so
     * existing catalogs are untouched — an untracked variant is always
     * sellable and shows no stock anywhere. Toggling it on starts the
     * ledger at zero; the merchant sets an opening balance through the
     * adjust dialog.
     */
    tracksInventory: boolean("tracks_inventory").notNull().default(false),
```

In `packages/db/src/rls.ts` line 144, change:

```ts
  const appendOnly = new Set(["audit_log"]);
```

to:

```ts
  // An audit trail — or a stock ledger — the application can rewrite is
  // neither. Both are append-only by ABSENT GRANT, not by discipline.
  const appendOnly = new Set(["audit_log", "stock_movements"]);
```

- [ ] **Step 5: Generate and inspect the migration**

```bash
export PATH="$HOME/.pnpm-shim:$PATH"
pnpm --filter @platform/db generate
```

Inspect the new `packages/db/drizzle/0005_*.sql`: it must contain `CREATE TABLE locations`, `CREATE TABLE stock_movements`, `CREATE TABLE stock_levels`, `ALTER TABLE "product_variants" ADD COLUMN "tracks_inventory" boolean DEFAULT false NOT NULL`, the two partial unique indexes, and the three CHECK constraints. No `CREATE INDEX CONCURRENTLY` (illegal — the migrator runs everything in one transaction). If drizzle-kit asks interactive questions, re-run with a clean tree and answer "create" for all three tables.

- [ ] **Step 6: Migrate**

```bash
pnpm db:migrate
```

Expected: migration applies, then the RLS script re-applies with the three new tables listed as tenant-scoped and the grants section showing `GRANT SELECT, INSERT ON "stock_movements"` (no UPDATE/DELETE).

- [ ] **Step 7: Extend the isolation suite**

In `packages/db/tests/isolation.test.ts`:

(a) The generic read-isolation loop passes vacuously on empty tables, so give the new tables rows on both sides. After `productA = await mkProduct(...)` / `productB = ...` in `beforeAll` (line ~129), add:

```ts
  // Inventory fixtures: without rows on both sides, the read-isolation
  // loop passes on the three new tables no matter what RLS does.
  const mkStock = async (tenantId: string, productId: string) => {
    const [variant] = await admin<{ id: string }[]>`
      SELECT id FROM product_variants WHERE product_id = ${productId}`;
    const [loc] = await admin<{ id: string }[]>`
      INSERT INTO locations (id, tenant_id, name, is_default)
      VALUES (${randomUUID()}, ${tenantId}, 'Default', true)
      RETURNING id`;
    await admin`
      INSERT INTO stock_movements (id, tenant_id, variant_id, location_id, delta, reason)
      VALUES (${randomUUID()}, ${tenantId}, ${variant!.id}, ${loc!.id}, 5, 'opening_balance')`;
    await admin`
      INSERT INTO stock_levels (tenant_id, variant_id, location_id, on_hand)
      VALUES (${tenantId}, ${variant!.id}, ${loc!.id}, 5)`;
  };
  await mkStock(tenantA, productA);
  await mkStock(tenantB, productB);
```

(b) Generalise the append-only test (line 230) to cover both tables — replace the whole `it("audit_log is append-only...")` block with:

```ts
  it.each(["audit_log", "stock_movements"])(
    "%s is append-only for the application role",
    async (table) => {
      const role = process.env.DB_APP_ROLE ?? "app_user";
      const [r] = await admin<{ upd: boolean; del: boolean; ins: boolean }[]>`
        SELECT has_table_privilege(${role}, ${table}, 'UPDATE') AS upd,
               has_table_privilege(${role}, ${table}, 'DELETE') AS del,
               has_table_privilege(${role}, ${table}, 'INSERT') AS ins`;

      // A history the application can rewrite is not a history.
      expect(r!.upd).toBe(false);
      expect(r!.del).toBe(false);
      expect(r!.ins).toBe(true);
    },
  );
```

No cleanup changes needed: everything cascades from the tenants delete in `afterAll` (which is exactly why Step 1's FK decision matters).

- [ ] **Step 8: Run the db suite**

```bash
pnpm --filter @platform/db test:integration
```

Expected: PASS. The suite was 32 tests; the `it.each` adds one (33). The read/write isolation loops now iterate the three new tables — if `locations`, `stock_movements` or `stock_levels` show up in a LEAK failure, the RLS script did not run (`pnpm db:migrate` again).

- [ ] **Step 9: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add packages/db docs/superpowers/specs/2026-08-15-inventory-ledger-design.md
git commit -m "feat(db): inventory ledger schema — locations, stock_movements (append-only), stock_levels, tracks_inventory"
```

---
### Task 2: The domain module — `@platform/core/inventory` + `/server`, with its integration suite

The single write door and every read the surfaces need. TDD: the suite is written first against a module that does not exist.

**Files:**
- Create: `packages/core/src/inventory/index.ts` (pure barrel)
- Create: `packages/core/src/inventory/server.ts`
- Modify: `packages/core/package.json` (two exports entries)
- Test: `packages/core/tests/inventory-ledger.integration.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's tables/types from `@platform/db`; `recordAudit(tx, tenantId, entry)` from `../audit/index`; `purgeStorefrontCache(tenantId, tags)` from `../catalog/purge`; `catalogPurgeTags(tenantId, productIds)` from `../catalog/cache-tags`; `WriteContext` type from `../catalog/writes`; `AppError` from `../errors`.
- Produces (Tasks 4–6 rely on these exact signatures):
  - `recordMovement(ctx: WriteContext, input: MovementInput): Promise<MovementResult>` where `MovementInput = { variantId: string; delta: number; note?: string | null; idempotencyKey?: string | null }` and `MovementResult = { movementId: string; variantId: string; productId: string; reason: StockMovementReason; delta: number; onHand: number; replayed: boolean }`.
  - `getStockLevels(tx: Tx, variantIds: string[]): Promise<Map<string, number>>` (variantId → summed on-hand; absent key = no rows = 0).
  - `listInventory(tenantId: string, opts?: { lowStockOnly?: boolean; limit?: number; offset?: number }): Promise<{ items: InventoryRow[]; total: number }>` where `InventoryRow = { variantId: string; productId: string; productTitle: string; sku: string; options: Record<string, string>; onHand: number; lowStockAt: number | null; isActive: boolean }`.
  - `getMovements(tenantId: string, variantId: string, opts?: { limit?: number; offset?: number }): Promise<MovementRow[]>` where `MovementRow = { id: string; delta: number; reason: StockMovementReason; note: string | null; createdAt: Date; createdByName: string | null }`.
  - `reconcileStockLevels(tenantId: string): Promise<{ variantId: string; locationId: string; ledger: number; projected: number }[]>` (empty array = clean).
  - Errors: `VariantNotFoundError` (404), `UntrackedVariantError` (422), `InsufficientStockError` (422).
  - Pure barrel: `isLowStock(onHand: number, lowStockAt: number | null): boolean`, `STOCK_ADJUSTMENT_MAX = 1_000_000`.

- [ ] **Step 1: Write the failing suite**

Create `packages/core/tests/inventory-ledger.integration.test.ts`. Fixture idiom (admin `postgres(DATABASE_URL_MIGRATOR)` connection, tracked-id cleanup) copies `catalog-queries.integration.test.ts`.

```ts
import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeConnections, withTenant } from "@platform/db";
import {
  InsufficientStockError,
  UntrackedVariantError,
  VariantNotFoundError,
  getMovements,
  getStockLevels,
  listInventory,
  recordMovement,
  reconcileStockLevels,
} from "@platform/core/inventory/server";

/**
 * The ledger's invariants, proven against real Postgres:
 * atomicity (a refused movement leaves NO ledger row), the CHECK-backed
 * oversell guard under real concurrency, idempotent replay, and the
 * projection's agreement with SUM(delta).
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantA: string;
let tenantB: string;
let userA: string;
let trackedVariant: string;
let untrackedVariant: string;
let otherTenantVariant: string;
let raceVariant: string;

const createdTenants = new Set<string>();
const createdUsers = new Set<string>();
const createdPlans = new Set<string>();

function ctx(tenantId: string) {
  return { tenantId, actorUserId: userA, ip: null, userAgent: null, requestId: "inv-test" };
}

async function makeTenant(): Promise<string> {
  const slug = "inv-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"inv-" + randomUUID().slice(0, 8)}, 'Inventory test plan')
    RETURNING id`;
  createdPlans.add(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  createdTenants.add(tenant!.id);
  return tenant!.id;
}

async function makeVariant(tenantId: string, tracked: boolean): Promise<string> {
  const [product] = await admin<{ id: string }[]>`
    INSERT INTO products (id, tenant_id, title, status)
    VALUES (${randomUUID()}, ${tenantId}, ${"inv-product-" + randomUUID().slice(0, 8)}, 'active')
    RETURNING id`;
  const [variant] = await admin<{ id: string }[]>`
    INSERT INTO product_variants
      (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory)
    VALUES
      (${randomUUID()}, ${tenantId}, ${product!.id}, ${"INV-" + randomUUID().slice(0, 8)},
       19900, 500, ${tracked})
    RETURNING id`;
  return variant!.id;
}

async function movementCount(variantId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = ${variantId}`;
  return row!.n;
}

beforeAll(async () => {
  tenantA = await makeTenant();
  tenantB = await makeTenant();
  userA = randomUUID();
  createdUsers.add(userA);
  const phone = "+9198" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userA}, ${phone}, 'Inv tester')`;

  trackedVariant = await makeVariant(tenantA, true);
  untrackedVariant = await makeVariant(tenantA, false);
  raceVariant = await makeVariant(tenantA, true);
  otherTenantVariant = await makeVariant(tenantB, true);
});

afterAll(async () => {
  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdUsers) await admin`DELETE FROM users WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  await closeConnections();
});

describe("recordMovement", () => {
  it("first movement is opening_balance; the projection and reads agree", async () => {
    const result = await recordMovement(ctx(tenantA), {
      variantId: trackedVariant,
      delta: 5,
      note: "opening count",
    });
    expect(result.reason).toBe("opening_balance");
    expect(result.onHand).toBe(5);
    expect(result.replayed).toBe(false);

    const levels = await withTenant(tenantA, (tx) => getStockLevels(tx, [trackedVariant]));
    expect(levels.get(trackedVariant)).toBe(5);
  });

  it("second movement is adjustment; sums correctly; reconcile is clean", async () => {
    const result = await recordMovement(ctx(tenantA), {
      variantId: trackedVariant,
      delta: -2,
      note: "damaged in transit",
    });
    expect(result.reason).toBe("adjustment");
    expect(result.onHand).toBe(3);

    expect(await reconcileStockLevels(tenantA)).toEqual([]);

    const history = await getMovements(tenantA, trackedVariant);
    expect(history.map((m) => m.delta)).toEqual([-2, 5]); // newest first
    expect(history[0]!.note).toBe("damaged in transit");
    expect(history[0]!.createdByName).toBe("Inv tester");
  });

  it("a movement below zero is refused atomically: 422 and NO ledger row", async () => {
    const before = await movementCount(trackedVariant);
    await expect(
      recordMovement(ctx(tenantA), { variantId: trackedVariant, delta: -99, note: "oops" }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await movementCount(trackedVariant)).toBe(before);
    expect(await reconcileStockLevels(tenantA)).toEqual([]);
  });

  it("refuses an untracked variant", async () => {
    await expect(
      recordMovement(ctx(tenantA), { variantId: untrackedVariant, delta: 1, note: "x" }),
    ).rejects.toBeInstanceOf(UntrackedVariantError);
  });

  it("another tenant's variant id is not found, not adjusted", async () => {
    await expect(
      recordMovement(ctx(tenantA), { variantId: otherTenantVariant, delta: 1, note: "x" }),
    ).rejects.toBeInstanceOf(VariantNotFoundError);
  });

  it("refuses delta 0 and deltas beyond the cap", async () => {
    for (const delta of [0, 1_000_001, -1_000_001]) {
      await expect(
        recordMovement(ctx(tenantA), { variantId: trackedVariant, delta, note: "x" }),
      ).rejects.toMatchObject({ status: 422 });
    }
  });

  it("replays an idempotency key instead of double-writing", async () => {
    const key = "idem-" + randomUUID();
    const before = await movementCount(trackedVariant);

    const first = await recordMovement(ctx(tenantA), {
      variantId: trackedVariant,
      delta: 1,
      note: "restock",
      idempotencyKey: key,
    });
    const second = await recordMovement(ctx(tenantA), {
      variantId: trackedVariant,
      delta: 1,
      note: "restock",
      idempotencyKey: key,
    });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.movementId).toBe(first.movementId);
    expect(second.onHand).toBe(first.onHand);
    expect(await movementCount(trackedVariant)).toBe(before + 1);
  });

  it("two concurrent decrements of the last unit: exactly one succeeds", async () => {
    await recordMovement(ctx(tenantA), { variantId: raceVariant, delta: 1, note: "one unit" });

    const results = await Promise.allSettled([
      recordMovement(ctx(tenantA), { variantId: raceVariant, delta: -1, note: "race A" }),
      recordMovement(ctx(tenantA), { variantId: raceVariant, delta: -1, note: "race B" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientStockError);

    const levels = await withTenant(tenantA, (tx) => getStockLevels(tx, [raceVariant]));
    expect(levels.get(raceVariant)).toBe(0);
    expect(await reconcileStockLevels(tenantA)).toEqual([]);
  });

  it("creates exactly one default location however many movements land", async () => {
    const [row] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM locations WHERE tenant_id = ${tenantA}`;
    expect(row!.n).toBe(1);
  });
});

describe("listInventory", () => {
  it("lists tracked variants with levels; lowStockOnly filters", async () => {
    const all = await listInventory(tenantA);
    const ids = all.items.map((i) => i.variantId);
    expect(ids).toContain(trackedVariant);
    expect(ids).toContain(raceVariant);
    expect(ids).not.toContain(untrackedVariant);
    expect(ids).not.toContain(otherTenantVariant);

    // raceVariant sits at 0 with the default lowStockAt of 2 → low.
    const low = await listInventory(tenantA, { lowStockOnly: true });
    expect(low.items.map((i) => i.variantId)).toContain(raceVariant);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @platform/core test:integration -- inventory-ledger`
Expected: FAIL at module load — `@platform/core/inventory/server` does not resolve.

- [ ] **Step 3: The pure barrel**

Create `packages/core/src/inventory/index.ts`:

```ts
/**
 * Inventory domain — PURE barrel, safe for client bundles.
 *
 * Everything that touches the database lives in ./server. This file must
 * not import @platform/db (whose root barrel pulls the postgres driver).
 */

/** Hard cap on one adjustment's magnitude; the route schema mirrors it. */
export const STOCK_ADJUSTMENT_MAX = 1_000_000;

/** Low-stock is a display state, not a schema fact: null threshold = never low. */
export function isLowStock(onHand: number, lowStockAt: number | null): boolean {
  return lowStockAt !== null && onHand <= lowStockAt;
}
```

- [ ] **Step 4: The server module**

Create `packages/core/src/inventory/server.ts`:

```ts
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  locations,
  products,
  productVariants,
  sql,
  stockLevels,
  stockMovements,
  users,
  withTenant,
} from "@platform/db";
import type { StockMovementReason, Tx } from "@platform/db";

import { recordAudit } from "../audit/index";
import { catalogPurgeTags } from "../catalog/cache-tags";
import { purgeStorefrontCache } from "../catalog/purge";
import type { WriteContext } from "../catalog/writes";
import { AppError } from "../errors";
import { STOCK_ADJUSTMENT_MAX } from "./index";

/**
 * The inventory ledger's single write door. SERVER ONLY.
 *
 * Blueprint §4.5: stock_movements is the source of truth,
 * stock_levels the projection — kept true HERE, in the same transaction
 * as the ledger insert, never by a second writer. The projection's
 * CHECK (on_hand >= 0) makes oversell a database impossibility: two
 * concurrent movements serialize on the projection row's lock and the
 * loser of a last-unit race gets a constraint violation this module
 * turns into a 422.
 *
 * Every entry point opens its own withTenant; the tenant id comes from
 * the caller's SESSION, never a payload. The variant is looked up with
 * an explicit SELECT first (the FK-does-not-enforce-tenancy trap — and
 * the ledger deliberately has no variant FK at all).
 */

export class VariantNotFoundError extends AppError {
  constructor(variantId: string) {
    super({
      code: "not_found",
      message: `Variant ${variantId} not found in this tenant`,
      status: 404,
      publicMessage: "That variant does not exist.",
    });
  }
}

export class UntrackedVariantError extends AppError {
  constructor(variantId: string) {
    super({
      code: "untracked_variant",
      message: `Variant ${variantId} does not track inventory`,
      status: 422,
      publicMessage: "Turn on inventory tracking for this variant before adjusting its stock.",
      details: {
        issues: [{ path: "variantId", message: "This variant does not track inventory." }],
      },
    });
  }
}

export class InsufficientStockError extends AppError {
  constructor(onHand: number, delta: number) {
    super({
      code: "insufficient_stock",
      message: `Movement of ${delta} refused: on-hand is ${onHand}`,
      status: 422,
      publicMessage: `That change would take stock below zero (on hand: ${onHand}).`,
      details: {
        issues: [{ path: "delta", message: `On hand is ${onHand}; stock cannot go below zero.` }],
      },
    });
  }
}

export type MovementInput = {
  variantId: string;
  delta: number;
  note?: string | null;
  idempotencyKey?: string | null;
};

export type MovementResult = {
  movementId: string;
  variantId: string;
  productId: string;
  reason: StockMovementReason;
  delta: number;
  onHand: number;
  replayed: boolean;
};

/** Walks err.cause chains for the root Postgres error code / text. */
function pgError(err: unknown): { code?: string; text: string } {
  let code: string | undefined;
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    const c = (cur as { code?: unknown }).code;
    if (!code && typeof c === "string") code = c;
    parts.push(String((cur as Error).message ?? cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return { code, text: parts.join(" ⇐ ") };
}

/**
 * Get-or-create the tenant's default location, inside the caller's
 * transaction. Race-safe via locations_one_default_key: the loser of a
 * concurrent create re-selects the winner's row.
 */
export async function ensureDefaultLocation(
  tx: Tx,
  tenantId: string,
): Promise<{ id: string }> {
  const select = () =>
    tx
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), eq(locations.isDefault, true)))
      .limit(1);

  const [existing] = await select();
  if (existing) return existing;

  const [created] = await tx
    .insert(locations)
    .values({ tenantId, name: "Default", isDefault: true })
    .onConflictDoNothing()
    .returning({ id: locations.id });
  if (created) return created;

  const [raced] = await select();
  if (!raced) throw new Error(`Default location for ${tenantId} neither created nor found`);
  return raced;
}

async function findByIdempotencyKey(
  tx: Tx,
  tenantId: string,
  key: string,
): Promise<Omit<MovementResult, "replayed"> | null> {
  const [movement] = await tx
    .select({
      movementId: stockMovements.id,
      variantId: stockMovements.variantId,
      reason: stockMovements.reason,
      delta: stockMovements.delta,
    })
    .from(stockMovements)
    .where(and(eq(stockMovements.tenantId, tenantId), eq(stockMovements.idempotencyKey, key)))
    .limit(1);
  if (!movement) return null;

  const [variant] = await tx
    .select({ productId: productVariants.productId })
    .from(productVariants)
    .where(eq(productVariants.id, movement.variantId))
    .limit(1);

  const levels = await getStockLevels(tx, [movement.variantId]);
  return {
    ...movement,
    productId: variant?.productId ?? "",
    onHand: levels.get(movement.variantId) ?? 0,
  };
}

/**
 * Record one stock movement and keep the projection true, atomically.
 *
 * Reason is chosen automatically: a variant's first movement is
 * `opening_balance`, everything after is `adjustment`. The response's
 * on-hand comes from the upsert's RETURNING, so before/after in the
 * audit row are exact even under concurrency.
 */
export async function recordMovement(
  ctx: WriteContext,
  input: MovementInput,
): Promise<MovementResult> {
  if (
    !Number.isInteger(input.delta) ||
    input.delta === 0 ||
    Math.abs(input.delta) > STOCK_ADJUSTMENT_MAX
  ) {
    throw new AppError({
      code: "invalid_payload",
      message: `delta must be a nonzero integer within ±${STOCK_ADJUSTMENT_MAX}, got ${input.delta}`,
      status: 422,
      publicMessage: "Some fields need attention.",
      details: { issues: [{ path: "delta", message: "Enter a nonzero whole number." }] },
    });
  }

  let result: MovementResult;
  try {
    result = await withTenant(ctx.tenantId, async (tx) => {
      const [variant] = await tx
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          tracksInventory: productVariants.tracksInventory,
        })
        .from(productVariants)
        .where(and(eq(productVariants.id, input.variantId), isNull(productVariants.deletedAt)))
        .limit(1);

      if (!variant) throw new VariantNotFoundError(input.variantId);
      if (!variant.tracksInventory) throw new UntrackedVariantError(input.variantId);

      // Fast path for a sequential retry; the 23505 catch below covers
      // the concurrent one.
      if (input.idempotencyKey) {
        const existing = await findByIdempotencyKey(tx, ctx.tenantId, input.idempotencyKey);
        if (existing) return { ...existing, replayed: true };
      }

      const location = await ensureDefaultLocation(tx, ctx.tenantId);

      const [prior] = await tx
        .select({ id: stockMovements.id })
        .from(stockMovements)
        .where(eq(stockMovements.variantId, input.variantId))
        .limit(1);
      const reason: StockMovementReason = prior ? "adjustment" : "opening_balance";

      const [movement] = await tx
        .insert(stockMovements)
        .values({
          tenantId: ctx.tenantId,
          variantId: input.variantId,
          locationId: location.id,
          delta: input.delta,
          reason,
          note: input.note ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          createdByUserId: ctx.actorUserId,
        })
        .returning({ id: stockMovements.id });

      // The projection upsert. RETURNING is the authoritative "after" —
      // exact under concurrency, where a pre-read would race.
      const [level] = await tx
        .insert(stockLevels)
        .values({
          tenantId: ctx.tenantId,
          variantId: input.variantId,
          locationId: location.id,
          onHand: input.delta,
        })
        .onConflictDoUpdate({
          target: [stockLevels.tenantId, stockLevels.variantId, stockLevels.locationId],
          set: {
            onHand: sql`${stockLevels.onHand} + ${input.delta}`,
            updatedAt: new Date(),
          },
        })
        .returning({ onHand: stockLevels.onHand });

      const onHand = level!.onHand;

      await recordAudit(tx, ctx.tenantId, {
        actorType: "staff",
        actorUserId: ctx.actorUserId,
        action: "inventory.adjusted",
        entityType: "product_variant",
        entityId: input.variantId,
        before: { onHand: onHand - input.delta },
        after: { onHand },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return {
        movementId: movement!.id,
        variantId: input.variantId,
        productId: variant.productId,
        reason,
        delta: input.delta,
        onHand,
        replayed: false,
      };
    });
  } catch (err) {
    const pg = pgError(err);

    // The oversell guard fired. The transaction is already rolled back
    // (an aborted tx refuses further queries), so the on-hand for the
    // message comes from a fresh read.
    if (pg.code === "23514" && pg.text.includes("stock_levels_on_hand_check")) {
      const onHand = await withTenant(ctx.tenantId, async (tx) => {
        const levels = await getStockLevels(tx, [input.variantId]);
        return levels.get(input.variantId) ?? 0;
      });
      throw new InsufficientStockError(onHand, input.delta);
    }

    // Two concurrent submits with one key: the loser replays the winner.
    if (
      pg.code === "23505" &&
      pg.text.includes("stock_movements_tenant_idem_key") &&
      input.idempotencyKey
    ) {
      const replay = await withTenant(ctx.tenantId, (tx) =>
        findByIdempotencyKey(tx, ctx.tenantId, input.idempotencyKey!),
      );
      if (replay) return { ...replay, replayed: true };
    }

    throw err;
  }

  // After the commit, never inside it. Fail-soft. A replay purges
  // nothing — it wrote nothing.
  if (!result.replayed) {
    await purgeStorefrontCache(ctx.tenantId, catalogPurgeTags(ctx.tenantId, [result.productId]));
  }

  return result;
}

/** Summed on-hand per variant, inside the caller's transaction. */
export async function getStockLevels(
  tx: Tx,
  variantIds: string[],
): Promise<Map<string, number>> {
  if (variantIds.length === 0) return new Map();
  const rows = await tx
    .select({
      variantId: stockLevels.variantId,
      onHand: sql<number>`coalesce(sum(${stockLevels.onHand}), 0)::int`.as("on_hand"),
    })
    .from(stockLevels)
    .where(inArray(stockLevels.variantId, variantIds))
    .groupBy(stockLevels.variantId);
  return new Map(rows.map((r) => [r.variantId, r.onHand]));
}

export type InventoryRow = {
  variantId: string;
  productId: string;
  productTitle: string;
  sku: string;
  options: Record<string, string>;
  onHand: number;
  lowStockAt: number | null;
  isActive: boolean;
};

/**
 * The /inventory page's query: tracked, live variants with their levels.
 *
 * A JOIN + GROUP BY rather than a correlated SELECT-list subquery — the
 * latter is the documented Drizzle trap (an interpolated outer column
 * renders unqualified and silently matches the inner table).
 */
export async function listInventory(
  tenantId: string,
  opts: { lowStockOnly?: boolean; limit?: number; offset?: number } = {},
): Promise<{ items: InventoryRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  return withTenant(tenantId, async (tx) => {
    const onHand = sql<number>`coalesce(sum(${stockLevels.onHand}), 0)::int`;
    // The condition only — .having() supplies the keyword. A null
    // threshold compares against -1, which a non-negative sum never
    // reaches: null lowStockAt = never low.
    const lowOnly = sql`coalesce(sum(${stockLevels.onHand}), 0) <= coalesce(${productVariants.lowStockAt}, -1)`;

    const rows = await tx
      .select({
        variantId: productVariants.id,
        productId: products.id,
        productTitle: products.title,
        sku: productVariants.sku,
        options: productVariants.options,
        lowStockAt: productVariants.lowStockAt,
        isActive: productVariants.isActive,
        onHand: onHand.as("on_hand"),
        total: sql<number>`count(*) over ()::int`.as("total"),
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(stockLevels, eq(stockLevels.variantId, productVariants.id))
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.tracksInventory, true),
          isNull(productVariants.deletedAt),
          isNull(products.deletedAt),
        ),
      )
      .groupBy(
        productVariants.id,
        products.id,
        products.title,
        productVariants.sku,
        productVariants.options,
        productVariants.lowStockAt,
        productVariants.isActive,
      )
      .having(opts.lowStockOnly ? lowOnly : undefined)
      .orderBy(asc(products.title), asc(productVariants.position))
      .limit(limit)
      .offset(offset);

    return {
      items: rows.map((r) => ({
        variantId: r.variantId,
        productId: r.productId,
        productTitle: r.productTitle,
        sku: r.sku,
        options: (r.options ?? {}) as Record<string, string>,
        onHand: r.onHand,
        lowStockAt: r.lowStockAt,
        isActive: r.isActive,
      })),
      total: rows[0]?.total ?? 0,
    };
  });
}

export type MovementRow = {
  id: string;
  delta: number;
  reason: StockMovementReason;
  note: string | null;
  createdAt: Date;
  createdByName: string | null;
};

/** A variant's movement history, newest first. `users` is control-plane (no RLS), so the join resolves. */
export async function getMovements(
  tenantId: string,
  variantId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<MovementRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        id: stockMovements.id,
        delta: stockMovements.delta,
        reason: stockMovements.reason,
        note: stockMovements.note,
        createdAt: stockMovements.createdAt,
        createdByName: users.name,
      })
      .from(stockMovements)
      .leftJoin(users, eq(users.id, stockMovements.createdByUserId))
      .where(eq(stockMovements.variantId, variantId))
      .orderBy(desc(stockMovements.createdAt), desc(stockMovements.id))
      .limit(limit)
      .offset(Math.max(opts.offset ?? 0, 0)),
  );
}

/**
 * SUM(ledger) vs projection, per (variant, location). Diagnostic — this
 * is the query that answers "why does this say 3 when I have 5?" and the
 * test that proves the projection cannot drift.
 */
export async function reconcileStockLevels(
  tenantId: string,
): Promise<{ variantId: string; locationId: string; ledger: number; projected: number }[]> {
  return withTenant(tenantId, async (tx) => {
    const ledger = await tx
      .select({
        variantId: stockMovements.variantId,
        locationId: stockMovements.locationId,
        ledger: sql<number>`sum(${stockMovements.delta})::int`.as("ledger"),
      })
      .from(stockMovements)
      .groupBy(stockMovements.variantId, stockMovements.locationId);

    const projected = await tx
      .select({
        variantId: stockLevels.variantId,
        locationId: stockLevels.locationId,
        projected: stockLevels.onHand,
      })
      .from(stockLevels);

    const key = (v: string, l: string) => `${v}:${l}`;
    const projectedBy = new Map(projected.map((p) => [key(p.variantId, p.locationId), p.projected]));
    const seen = new Set<string>();
    const mismatches: { variantId: string; locationId: string; ledger: number; projected: number }[] = [];

    for (const row of ledger) {
      const k = key(row.variantId, row.locationId);
      seen.add(k);
      const proj = projectedBy.get(k) ?? 0;
      if (proj !== row.ledger) {
        mismatches.push({ ...row, projected: proj });
      }
    }
    for (const p of projected) {
      if (!seen.has(key(p.variantId, p.locationId)) && p.projected !== 0) {
        mismatches.push({ variantId: p.variantId, locationId: p.locationId, ledger: 0, projected: p.projected });
      }
    }
    return mismatches;
  });
}
```

Add the two subpaths to `packages/core/package.json` `exports` (after `"./media"`):

```json
    "./inventory": "./src/inventory/index.ts",
    "./inventory/server": "./src/inventory/server.ts"
```

Do NOT add inventory to the core root barrel (`src/index.ts`) — the root barrel already `export *`s `catalog/server` and collisions poison it silently; subpath imports are the pattern.

- [ ] **Step 5: Run the suite to verify it passes**

Run: `pnpm --filter @platform/core test:integration -- inventory-ledger`
Expected: PASS, 10 tests. `cache.purge_unconfigured` warnings on stdout are fine (purge is fail-soft; the console suite asserts it properly in Task 4).

- [ ] **Step 6: Typecheck, lint, full core suites**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @platform/core test && pnpm --filter @platform/core test:integration`
Expected: clean; core integration 25 → 35.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/inventory packages/core/package.json packages/core/tests/inventory-ledger.integration.test.ts
git commit -m "feat(core): inventory ledger domain — recordMovement, projections, reconcile"
```

---
### Task 3: `tracks_inventory` through the catalog write path and the CSV

The flag rides the machinery `isActive` already rides: zod payload, form state, product form checkbox, domain write, bulk merge, CSV column. Blank-states-nothing everywhere.

**Files:**
- Modify: `packages/core/src/catalog/writes.ts:145-163` (VariantInput) and `:555-567` (the columns object)
- Modify: `packages/core/src/catalog/console-queries.ts` (variant select + `ConsoleProduct` type — locate the two `lowStockAt` sites with `grep -n lowStockAt`)
- Modify: `packages/core/src/catalog/bulk.ts:504-506, 520-522, ~644, 797-798`
- Modify: `packages/core/src/catalog/csv.ts:137, ~431, ~481, ~509, ~1086-1100`
- Modify: `apps/console/src/lib/catalog-input.ts:141-143, 209-211`
- Modify: `apps/console/src/lib/product-form-state.ts` (the four `isActive` sites: type :42, blank :126, fromProduct :191, plus the payload mapper — `grep -n isActive`)
- Modify: `apps/console/src/app/products/ProductForm.tsx` (~:546-553 checkbox column, :581-585 paragraph)
- Test: the existing core CSV/bulk unit suites (extended)

**Interfaces:**
- Consumes: `productVariants.tracksInventory` from Task 1.
- Produces: `VariantInput.tracksInventory: boolean` (writes.ts) — Task 4's fixtures and Task 6's queries rely on the column being writable end-to-end; CSV column `variant_tracks_inventory`.

- [ ] **Step 1: Domain write**

In `packages/core/src/catalog/writes.ts` add to `VariantInput` (after `lowStockAt: number | null;`, line 160):

```ts
  /** Opt-in ledger tracking (§4.5). Untracked = always sellable, no stock shown. */
  tracksInventory: boolean;
```

and to the `columns` object in the variant write loop (after `lowStockAt: variant.lowStockAt,`, line 563):

```ts
      tracksInventory: variant.tracksInventory,
```

- [ ] **Step 2: Console read-back**

In `packages/core/src/catalog/console-queries.ts`, run `grep -n "lowStockAt" src/catalog/console-queries.ts` — it appears twice (the `ConsoleProduct` variants type and the variant select in `getProductForConsole`). Add `tracksInventory` alongside both, same shapes as `isActive`:

- type: `tracksInventory: boolean;`
- select: `tracksInventory: productVariants.tracksInventory,`

- [ ] **Step 3: Bulk merge and change labels**

In `packages/core/src/catalog/bulk.ts`:

- Merge pick (after line 506 `isActive: row.isActive ?? existing?.isActive ?? true,`):

```ts
    tracksInventory: row.tracksInventory ?? existing?.tracksInventory ?? false,
```

- `toVariantInput` (after line 522 `isActive: v.isActive,`):

```ts
    tracksInventory: v.tracksInventory,
```

- `changedFields`'s variant comparison (the `||` chain around line 644 ending `variant.isActive !== stored.isActive`): add one more clause:

```ts
        variant.tracksInventory !== stored.tracksInventory ||
```

- The export mapping around lines 797-798 (after `isActive: v.isActive,`):

```ts
          tracksInventory: v.tracksInventory,
```

- [ ] **Step 4: CSV column**

In `packages/core/src/catalog/csv.ts`, mirror `variant_active` exactly at each of its four sites:

- Column list (line 137): add `"variant_tracks_inventory",` directly after `"variant_active",`.
- The serializer-input variant type (~line 431, has `isActive: boolean;`): add `tracksInventory: boolean;`.
- The export cell (~line 481): after `cells.variant_active = variant.isActive ? "true" : "false";` add:

```ts
    cells.variant_tracks_inventory = variant.tracksInventory ? "true" : "false";
```

- The parse draft type (~line 509, has `isActive?: boolean;`): add `tracksInventory?: boolean;`.
- The import parse block (~lines 1086-1100): mirror the `variant_active` block —

```ts
  if (has("variant_tracks_inventory")) {
    const cell = cellValue("variant_tracks_inventory");
    if (cell !== "") {
      draft.tracksInventory = readBoolean(cell, "variant_tracks_inventory", report);
    }
  }
```

(Adapt the exact helper names — `has`/`cell`/`readBoolean` — to what the `variant_active` block at 1086-1100 actually uses; the semantics to preserve is BLANK STATES NOTHING: a blank cell must leave `draft.tracksInventory` undefined so the bulk merge keeps the stored value.)

- [ ] **Step 5: Console payload + form state + form**

In `apps/console/src/lib/catalog-input.ts`: after line 143 (`isActive: z.boolean().default(true),`) add:

```ts
  tracksInventory: z.boolean().default(false),
```

and in the payload mapping after line 211 (`isActive: v.isActive,`):

```ts
      tracksInventory: v.tracksInventory,
```

In `apps/console/src/lib/product-form-state.ts`, `grep -n isActive` and mirror at every site: the `VariantFormState` type (`tracksInventory: boolean;`), the blank variant (`tracksInventory: false,`), the from-product mapping (`tracksInventory: v.tracksInventory,`), and the to-payload mapping (`tracksInventory: v.tracksInventory,`).

In `apps/console/src/app/products/ProductForm.tsx`:

- In the variants table, add a "Tracked" checkbox column directly BEFORE the "for sale" checkbox `<td>` (lines 546-553), same shape:

```tsx
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Variant ${index + 1} tracks inventory`}
                    checked={variant.tracksInventory}
                    onChange={(e) =>
                      updateVariant(variant.key, { tracksInventory: e.target.checked })
                    }
                  />
                </td>
```

- Add the matching `<th>Tracked</th>` before the header cell of the "for sale" column (find the `<thead>` of this table; its column order must match the `<td>` order).
- Replace the stock paragraph (lines 581-585) with:

```tsx
        <p className="muted">
          Tracked variants carry a stock count in the ledger — manage quantities from the
          Inventory page or the panel below. A variant tracked at zero shows as out of stock
          on the storefront; untracked variants are always available.
        </p>
```

- [ ] **Step 6: Extend the CSV/bulk unit tests**

Locate the existing unit tests that pin `variant_active`'s semantics: `grep -rn "variant_active" packages/core/src packages/core/tests --include="*.test.ts"`. In the same files, clone the two load-bearing tests for the new column, asserting:

1. **Round-trip:** a variant with `tracksInventory: true` exports `variant_tracks_inventory` as `"true"`, and re-importing the exported file is a no-op (the merged product's `changes` list is empty).
2. **Blank states nothing, asserted with the flag ON:** import a file whose `variant_tracks_inventory` cell is blank against a stored variant with `tracksInventory: true` → the merged input keeps `true`. (Asserting with the flag ON is what makes a silent default-off fail the test — the `variant_active` lesson.)
3. **Change label:** flipping the flag via import produces a `changes` entry naming the variant (assert through `changedFields`' existing granularity — clone the `isActive`-flip test if one exists, otherwise assert the changes list is non-empty for the flip and empty without it).

- [ ] **Step 7: Verify, gate, commit**

```bash
pnpm typecheck && pnpm lint && pnpm --filter @platform/core test && pnpm build
```

Expected: clean, 2/2 builds (the ProductForm change must not drag anything new into client chunks — the flag is a plain boolean prop). Then the console + core integration suites as regression:

```bash
pnpm --filter @platform/core test:integration && pnpm --filter @platform/console test:integration
```

Expected: PASS at the Task 2 counts (console still 107 — this task adds unit tests only).

```bash
git add packages/core/src/catalog apps/console/src/lib apps/console/src/app/products/ProductForm.tsx packages/core/tests packages/core/src
git commit -m "feat(catalog): tracks_inventory through the write path, form, and CSV"
```

---

### Task 4: `POST /api/inventory/movements` and the console integration suite

The adjust endpoint, TDD. The suite also carries the purge-after-commit assertion (core's suite runs purge unconfigured; this one runs it against a stub storefront).

**Files:**
- Create: `apps/console/src/app/api/inventory/movements/route.ts`
- Test: `apps/console/tests/inventory-movements.integration.test.ts` (new)

**Interfaces:**
- Consumes: `recordMovement` (Task 2), `handleCatalogWrite(req, schema, run, { permission, successStatus })` (`apps/console/src/lib/catalog-routes.ts:66`), `STOCK_ADJUSTMENT_MAX` from `@platform/core/inventory`.
- Produces: `POST /api/inventory/movements` — body `{ variantId: uuid, delta: int≠0, note: string(1..500), idempotencyKey?: string(8..100) }` → 201 `{ movementId, variantId, productId, reason, delta, onHand, replayed, requestId }`. Task 5's dialog calls this.

- [ ] **Step 1: Write the failing suite**

Create `apps/console/tests/inventory-movements.integration.test.ts`. Harness (mocked `next/headers`, migrator connection, tracked-id cleanup) copies `settings.integration.test.ts`; the purge stub copies the minimal shape of `cache-purge.integration.test.ts`.

```ts
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * POST /api/inventory/movements against real PostgreSQL, with a stub
 * storefront capturing purges. The route handler is called directly with
 * a constructed Request; only next/headers is stubbed.
 */

let sessionToken: string | undefined;

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "console_session" && sessionToken ? { name, value: sessionToken } : undefined,
    }),
  headers: () => Promise.resolve(new Headers()),
}));

const { POST: postMovementRoute } = await import("../src/app/api/inventory/movements/route");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

const TEST_SECRET = "inventory-purge-secret-9f21ce";
let purgeServer: Server;
let received: { tags: string[]; tenantId: string }[] = [];
let savedOrigin: string | undefined;
let savedSecret: string | undefined;

let tenantId: string;
let ownerToken: string;
let processorToken: string;
let productId: string;
let trackedVariant: string;
let untrackedVariant: string;

const createdTenants = new Set<string>();
const createdUsers = new Set<string>();
const createdPlans = new Set<string>();

async function makeSession(tenant: string, role: string): Promise<string> {
  const userId = randomUUID();
  createdUsers.add(userId);
  const phone = "+9196" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userId}, ${phone}, 'Inv route test')`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, role, accepted_at)
    VALUES (${tenant}, ${userId}, ${role}, now())`;
  const token = randomUUID() + randomUUID();
  await admin`
    INSERT INTO sessions (id, token_hash, user_id, tenant_id, expires_at, idle_expires_at)
    VALUES (${randomUUID()}, ${createHash("sha256").update(token).digest("hex")},
            ${userId}, ${tenant}, now() + interval '1 day', now() + interval '1 day')`;
  return token;
}

async function postMovement(
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await postMovementRoute(
    new Request("http://console.test/api/inventory/movements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function ledgerCount(variantId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = ${variantId}`;
  return row!.n;
}

beforeAll(async () => {
  const slug = "invr-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"invr-" + randomUUID().slice(0, 8)}, 'Inv route plan')
    RETURNING id`;
  createdPlans.add(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  tenantId = tenant!.id;
  createdTenants.add(tenantId);

  ownerToken = await makeSession(tenantId, "owner");
  processorToken = await makeSession(tenantId, "order_processor"); // inventory:read, NOT write

  const [product] = await admin<{ id: string }[]>`
    INSERT INTO products (id, tenant_id, title, status)
    VALUES (${randomUUID()}, ${tenantId}, 'Inv route product', 'active')
    RETURNING id`;
  productId = product!.id;
  // Distinct options per variant: product_variants_option_combo_key is
  // unique on (tenant, product, options), and two `{}` rows collide.
  const mkVariant = async (tracked: boolean, size: string) => {
    const [v] = await admin<{ id: string }[]>`
      INSERT INTO product_variants
        (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory, options)
      VALUES (${randomUUID()}, ${tenantId}, ${productId},
              ${"INVR-" + randomUUID().slice(0, 8)}, 9900, 250, ${tracked},
              ${JSON.stringify({ Size: size })}::text::jsonb)
      RETURNING id`;
    return v!.id;
  };
  trackedVariant = await mkVariant(true, "M");
  untrackedVariant = await mkVariant(false, "L");

  // Stub storefront: capture every purge POST.
  purgeServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      received.push(JSON.parse(body) as { tags: string[]; tenantId: string });
      res.statusCode = 200;
      res.end('{"purged":1}');
    });
  });
  await new Promise<void>((resolve) => purgeServer.listen(0, "127.0.0.1", resolve));
  const address = purgeServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  savedOrigin = process.env.STOREFRONT_INTERNAL_ORIGIN;
  savedSecret = process.env.INTERNAL_API_SECRET;
  process.env.STOREFRONT_INTERNAL_ORIGIN = `http://127.0.0.1:${port}`;
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
});

afterEach(() => {
  sessionToken = undefined;
  received = [];
});

afterAll(async () => {
  // Restore env BEFORE the pool closes (the worker-suite lesson).
  if (savedOrigin === undefined) delete process.env.STOREFRONT_INTERNAL_ORIGIN;
  else process.env.STOREFRONT_INTERNAL_ORIGIN = savedOrigin;
  if (savedSecret === undefined) delete process.env.INTERNAL_API_SECRET;
  else process.env.INTERNAL_API_SECRET = savedSecret;
  await new Promise<void>((resolve) => purgeServer.close(() => resolve()));
  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdUsers) await admin`DELETE FROM users WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  await closeConnections();
});

describe("POST /api/inventory/movements", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const { status } = await postMovement({ variantId: trackedVariant, delta: 1, note: "x" });
    expect(status).toBe(401);
  });

  it("refuses a role holding only inventory:read with 403, writing nothing", async () => {
    sessionToken = processorToken;
    const before = await ledgerCount(trackedVariant);
    const { status } = await postMovement({ variantId: trackedVariant, delta: 1, note: "x" });
    expect(status).toBe(403);
    expect(await ledgerCount(trackedVariant)).toBe(before);
  });

  it("refuses delta 0 and a missing note with field-level 422s", async () => {
    sessionToken = ownerToken;
    const zero = await postMovement({ variantId: trackedVariant, delta: 0, note: "x" });
    expect(zero.status).toBe(422);
    const zeroIssues = (zero.data.error as { details: { issues: { path: string }[] } }).details.issues;
    expect(zeroIssues.some((i) => i.path === "delta")).toBe(true);

    const noNote = await postMovement({ variantId: trackedVariant, delta: 1 });
    expect(noNote.status).toBe(422);
    const noteIssues = (noNote.data.error as { details: { issues: { path: string }[] } }).details.issues;
    expect(noteIssues.some((i) => i.path === "note")).toBe(true);
  });

  it("404s an unknown variant id", async () => {
    sessionToken = ownerToken;
    const { status } = await postMovement({ variantId: randomUUID(), delta: 1, note: "x" });
    expect(status).toBe(404);
  });

  it("refuses an untracked variant with 422", async () => {
    sessionToken = ownerToken;
    const { status, data } = await postMovement({ variantId: untrackedVariant, delta: 1, note: "x" });
    expect(status).toBe(422);
    expect((data.error as { code: string }).code).toBe("untracked_variant");
  });

  it("records a movement: ledger row, projection, audit, purge after commit", async () => {
    sessionToken = ownerToken;
    const { status, data } = await postMovement({
      variantId: trackedVariant,
      delta: 5,
      note: "opening count",
    });
    expect(status).toBe(201);
    expect(data.onHand).toBe(5);
    expect(data.reason).toBe("opening_balance");

    const [level] = await admin<{ on_hand: number }[]>`
      SELECT on_hand FROM stock_levels WHERE variant_id = ${trackedVariant}`;
    expect(level!.on_hand).toBe(5);

    const audits = await admin<{ before: unknown; after: unknown }[]>`
      SELECT before, after FROM audit_log
      WHERE tenant_id = ${tenantId} AND action = 'inventory.adjusted'
        AND entity_id = ${trackedVariant}`;
    expect(audits.length).toBe(1);

    expect(received.length).toBe(1);
    expect(received[0]!.tenantId).toBe(tenantId);
    expect(received[0]!.tags).toContain(`t:${tenantId}:product:${productId}`);
  });

  it("refuses going below zero with 422, no ledger row, no purge", async () => {
    sessionToken = ownerToken;
    const before = await ledgerCount(trackedVariant);
    const { status, data } = await postMovement({
      variantId: trackedVariant,
      delta: -99,
      note: "impossible",
    });
    expect(status).toBe(422);
    expect((data.error as { code: string }).code).toBe("insufficient_stock");
    expect(await ledgerCount(trackedVariant)).toBe(before);
    expect(received.length).toBe(0);
  });

  it("replays an idempotency key: one ledger row, second response flagged", async () => {
    sessionToken = ownerToken;
    const key = "route-idem-" + randomUUID();
    const before = await ledgerCount(trackedVariant);

    const first = await postMovement({
      variantId: trackedVariant, delta: 2, note: "restock", idempotencyKey: key,
    });
    const second = await postMovement({
      variantId: trackedVariant, delta: 2, note: "restock", idempotencyKey: key,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.data.replayed).toBe(false);
    expect(second.data.replayed).toBe(true);
    expect(second.data.movementId).toBe(first.data.movementId);
    expect(await ledgerCount(trackedVariant)).toBe(before + 1);
    // The replay wrote nothing, so it must purge nothing.
    expect(received.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @platform/console test:integration -- inventory-movements`
Expected: FAIL at module load — the route file does not exist.

- [ ] **Step 3: Write the route**

Create `apps/console/src/app/api/inventory/movements/route.ts`:

```ts
import type { NextResponse } from "next/server";

import { STOCK_ADJUSTMENT_MAX } from "@platform/core/inventory";
import { recordMovement } from "@platform/core/inventory/server";
import { z } from "zod";

import { handleCatalogWrite } from "../../../../lib/catalog-routes";

/**
 * The adjust endpoint — the ONLY HTTP writer of stock_movements.
 *
 * The note is required here even though the column is nullable: a
 * merchant-initiated movement without a note is an audit answer that
 * says nothing; future automated movements (orders, RTO) carry
 * references instead and use recordMovement directly.
 */
const movementPayloadSchema = z.object({
  variantId: z.string().uuid(),
  delta: z
    .number()
    .int()
    .refine((d) => d !== 0, { message: "Enter a nonzero whole number." })
    .refine((d) => Math.abs(d) <= STOCK_ADJUSTMENT_MAX, {
      message: `Adjustments are capped at ${STOCK_ADJUSTMENT_MAX.toLocaleString("en-IN")}.`,
    }),
  note: z.string().trim().min(1, { message: "A note is required." }).max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  return handleCatalogWrite(
    req,
    movementPayloadSchema,
    (ctx, payload) => recordMovement(ctx, payload),
    { permission: "inventory:write", successStatus: 201 },
  );
}
```

(A replayed request also answers 201 — the resource exists and the body carries `replayed: true`; distinguishing 200/201 per replay would complicate `handleCatalogWrite` for no consumer.)

- [ ] **Step 4: Run the suite to verify it passes**

Run: `pnpm --filter @platform/console test:integration -- inventory-movements`
Expected: PASS, 9 tests.

- [ ] **Step 5: Full typecheck, lint, and the whole integration matrix**

Run: `pnpm typecheck && pnpm lint && pnpm test:integration`
Expected: clean; console 107 → 116, core at Task 2's count, everything else unchanged. If any OTHER suite broke, stop and investigate.

- [ ] **Step 6: Commit**

```bash
git add apps/console/src/app/api/inventory apps/console/tests/inventory-movements.integration.test.ts
git commit -m "feat(console): POST /api/inventory/movements — the audited, idempotent adjust endpoint"
```

---
### Task 5: Console UI — `/inventory`, the adjust dialog, history, and the product-page panel

Server components read through core directly (the settings-page precedent: no GET routes — see reviewer notes). One client component: the adjust dialog.

**Files:**
- Create: `apps/console/src/app/inventory/page.tsx`
- Create: `apps/console/src/app/inventory/AdjustStock.tsx`
- Create: `apps/console/src/app/inventory/[variantId]/page.tsx`
- Modify: `apps/console/src/app/products/[id]/page.tsx` (inventory panel under the form)
- Modify: `apps/console/src/app/page.tsx` (toolbar chip)

**Interfaces:**
- Consumes: `listInventory`, `getMovements`, `getStockLevels` (Task 2 signatures), `isLowStock` from `@platform/core/inventory`, `POST /api/inventory/movements` (Task 4), `requireActor` / `can` per existing pages.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: The adjust dialog (client)**

Create `apps/console/src/app/inventory/AdjustStock.tsx`. Fetch-based, no Server Actions (prior decision). One idempotency key per OPENED dialog: retries of the same submission replay; reopening is a new intent.

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Issue = { path: string; message: string };

type Props = {
  variantId: string;
  sku: string;
  onHand: number;
  canWrite: boolean;
};

export function AdjustStock({ variantId, sku, onHand, canWrite }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [idemKey, setIdemKey] = useState("");

  function openDialog(): void {
    setOpen(true);
    setDelta("");
    setNote("");
    setIssues([]);
    setIdemKey(crypto.randomUUID());
  }

  const parsed = /^-?\d+$/.test(delta.trim()) ? Number.parseInt(delta.trim(), 10) : null;
  const preview = parsed === null ? null : onHand + parsed;
  const submittable = parsed !== null && parsed !== 0 && note.trim().length > 0 && !busy;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (parsed === null) return;
    setBusy(true);
    setIssues([]);
    try {
      const res = await fetch("/api/inventory/movements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variantId, delta: parsed, note: note.trim(), idempotencyKey: idemKey }),
      });
      const data = (await res.json()) as {
        error?: { message?: string; details?: { issues?: Issue[] } };
      };
      if (!res.ok) {
        setIssues(
          data.error?.details?.issues ?? [
            { path: "form", message: data.error?.message ?? "That could not be saved." },
          ],
        );
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setIssues([{ path: "form", message: "The console could not reach the server." }]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="chip" onClick={openDialog} disabled={!canWrite}>
        Adjust
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="panel" style={{ marginTop: 8 }}>
      <p className="muted">
        {sku}: {onHand} on hand
        {preview !== null && <> → <strong>{preview}</strong></>}
      </p>
      <div className="row">
        <div>
          <label htmlFor={`delta-${variantId}`}>Change (± quantity)</label>
          <input
            id={`delta-${variantId}`}
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            inputMode="numeric"
            placeholder="+5 or -2"
            autoFocus
          />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor={`note-${variantId}`}>Note (required)</label>
          <input
            id={`note-${variantId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Stock count, damage, correction…"
          />
        </div>
      </div>
      {issues.length > 0 && (
        <ul className="error">
          {issues.map((issue, i) => (
            <li key={`${issue.path}-${i}`}>
              {issue.path === "form" ? "" : `${issue.path}: `}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button type="submit" disabled={!submittable}>
          {busy ? "Saving…" : "Save movement"}
        </button>
        <button type="button" className="chip" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: The `/inventory` page**

Create `apps/console/src/app/inventory/page.tsx`, modeled on `products/page.tsx` (server component, GET params for filter/page):

```tsx
import Link from "next/link";

import { can } from "@platform/core";
import { isLowStock } from "@platform/core/inventory";
import { listInventory } from "@platform/core/inventory/server";

import { requireActor } from "../../lib/session";
import { AdjustStock } from "./AdjustStock";

export const dynamic = "force-dynamic";

/**
 * The daily screen: every tracked variant and its level. Untracked
 * variants are deliberately absent — tracking is opt-in and this page is
 * the list of what opted in.
 */

const PAGE_SIZE = 50;

type Search = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function InventoryPage({ searchParams }: Search) {
  const actor = await requireActor();

  if (!can(actor, "inventory:read")) {
    return (
      <main>
        <h1>Inventory</h1>
        <p className="error">Your role does not include access to inventory.</p>
      </main>
    );
  }

  const params = await searchParams;
  const lowOnly = first(params.low) === "1";
  const page = Math.max(Number.parseInt(first(params.page) ?? "1", 10) || 1, 1);

  const { items, total } = await listInventory(actor.tenantId, {
    lowStockOnly: lowOnly,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const writable = can(actor, "inventory:write");

  return (
    <main>
      <nav className="crumbs">
        <Link href="/">Dashboard</Link> · <Link href="/products">Products</Link>
      </nav>

      <h1>Inventory</h1>
      <p className="muted">
        {total} tracked {total === 1 ? "variant" : "variants"}
        {lowOnly ? " · low stock" : ""}
      </p>

      <div className="panel">
        <nav className="toolbar">
          <Link href="/inventory" className="chip" aria-current={!lowOnly ? "page" : undefined}>
            All
          </Link>
          <Link href="/inventory?low=1" className="chip" aria-current={lowOnly ? "page" : undefined}>
            Low stock
          </Link>
        </nav>
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <p className="muted">
            {lowOnly
              ? "Nothing is low on stock."
              : "No tracked variants yet. Turn on tracking from a product's variants table."}
          </p>
        </div>
      ) : (
        <div className="panel">
          <table className="grid">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th style={{ textAlign: "right" }}>On hand</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.variantId}>
                  <td>
                    <Link href={`/products/${row.productId}`}>{row.productTitle}</Link>
                    {Object.keys(row.options).length > 0 && (
                      <div className="muted">
                        {Object.entries(row.options)
                          .map(([axis, value]) => `${axis}: ${value}`)
                          .join(" · ")}
                      </div>
                    )}
                    {!row.isActive && <div className="muted">not for sale</div>}
                  </td>
                  <td>
                    <code>{row.sku}</code>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {row.onHand}
                    {isLowStock(row.onHand, row.lowStockAt) && (
                      <>
                        {" "}
                        <span className="badge badge-draft">low</span>
                      </>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <AdjustStock
                      variantId={row.variantId}
                      sku={row.sku}
                      onHand={row.onHand}
                      canWrite={writable}
                    />{" "}
                    <Link href={`/inventory/${row.variantId}`} className="chip">
                      History
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="pagination" aria-label="Pagination">
          {page > 1 && (
            <Link href={`/inventory?${lowOnly ? "low=1&" : ""}page=${page - 1}`} rel="prev">
              ← Previous
            </Link>
          )}
          <span className="muted">
            Page {page} of {pages}
          </span>
          {page < pages && (
            <Link href={`/inventory?${lowOnly ? "low=1&" : ""}page=${page + 1}`} rel="next">
              Next →
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
```

- [ ] **Step 3: The history page**

Create `apps/console/src/app/inventory/[variantId]/page.tsx`:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@platform/core";
import { getMovements } from "@platform/core/inventory/server";
import { and, eq, isNull, products, productVariants, withTenant } from "@platform/db";

import { requireActor } from "../../../lib/session";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The timestamped answer to "why does this say 3 when I have 5?". */
export default async function MovementHistoryPage({
  params,
}: {
  params: Promise<{ variantId: string }>;
}) {
  const actor = await requireActor();
  const { variantId } = await params;
  if (!UUID_RE.test(variantId)) notFound();

  if (!can(actor, "inventory:read")) {
    return (
      <main>
        <h1>Stock history</h1>
        <p className="error">Your role does not include access to inventory.</p>
      </main>
    );
  }

  const variant = await withTenant(actor.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        sku: productVariants.sku,
        productId: products.id,
        productTitle: products.title,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(eq(productVariants.id, variantId), isNull(productVariants.deletedAt)))
      .limit(1);
    return row ?? null;
  });

  // Another tenant's variant is invisible under RLS → plain 404.
  if (!variant) notFound();

  const movements = await getMovements(actor.tenantId, variantId, { limit: 200 });
  const total = movements.reduce((sum, m) => sum + m.delta, 0);

  return (
    <main>
      <nav className="crumbs">
        <Link href="/inventory">Inventory</Link> ·{" "}
        <Link href={`/products/${variant.productId}`}>{variant.productTitle}</Link>
      </nav>

      <h1>Stock history</h1>
      <p className="muted">
        <code>{variant.sku}</code> · {movements.length}{" "}
        {movements.length === 1 ? "movement" : "movements"} · sums to {total}
      </p>

      {movements.length === 0 ? (
        <div className="panel">
          <p className="muted">No movements yet.</p>
        </div>
      ) : (
        <div className="panel">
          <table className="grid">
            <thead>
              <tr>
                <th>When</th>
                <th style={{ textAlign: "right" }}>Change</th>
                <th>Reason</th>
                <th>Note</th>
                <th>Who</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m.id}>
                  <td>{m.createdAt.toLocaleString("en-IN")}</td>
                  <td style={{ textAlign: "right" }}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                  <td>{m.reason === "opening_balance" ? "opening balance" : "adjustment"}</td>
                  <td>{m.note ?? <span className="muted">—</span>}</td>
                  <td>{m.createdByName ?? <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 4: The product-page panel and the nav chip**

In `apps/console/src/app/products/[id]/page.tsx`:

- Add imports: `can` already imported; add `getStockLevels` from `@platform/core/inventory/server`, `withTenant` from `@platform/db`, and `AdjustStock` from `../../inventory/AdjustStock`.
- After the three parallel fetches and the `notFound()` guard, compute levels for the tracked variants:

```tsx
  const trackedVariants = product.variants.filter((v) => v.tracksInventory);
  const levels =
    trackedVariants.length > 0
      ? await withTenant(actor.tenantId, (tx) =>
          getStockLevels(tx, trackedVariants.map((v) => v.id)),
        )
      : new Map<string, number>();
```

- After the `<ProductForm …/>` element, render the panel:

```tsx
      {trackedVariants.length > 0 && can(actor, "inventory:read") && (
        <div className="panel">
          <h2 className="section">Inventory</h2>
          <table className="grid">
            <thead>
              <tr>
                <th>SKU</th>
                <th style={{ textAlign: "right" }}>On hand</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {trackedVariants.map((v) => (
                <tr key={v.id}>
                  <td>
                    <code>{v.sku}</code>
                  </td>
                  <td style={{ textAlign: "right" }}>{levels.get(v.id) ?? 0}</td>
                  <td style={{ textAlign: "right" }}>
                    <AdjustStock
                      variantId={v.id}
                      sku={v.sku}
                      onHand={levels.get(v.id) ?? 0}
                      canWrite={can(actor, "inventory:write")}
                    />{" "}
                    <Link href={`/inventory/${v.id}`} className="chip">
                      History
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            A newly tracked variant starts at zero — record its opening balance here before it
            reads as out of stock on the storefront.
          </p>
        </div>
      )}
```

(If `ConsoleProduct`'s variant rows lack `id` in this page's `product.variants`, check `getProductForConsole` — it returns variant ids; `toFormState` consumes them. Use whatever field carries the variant id there.)

In `apps/console/src/app/page.tsx`, the toolbar nav (currently OR-gated on `catalog:read || settings:read`): extend the gate with `|| can(actor, "inventory:read")` and add, between the catalog chips and the Settings chip:

```tsx
          {can(actor, "inventory:read") && (
            <Link href="/inventory" className="chip">
              Inventory
            </Link>
          )}
```

- [ ] **Step 5: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean, 2/2 Next apps. `AdjustStock` imports nothing from `@platform/db` or the server barrels — the build is the boundary check.

- [ ] **Step 6: Commit**

```bash
git add apps/console/src/app/inventory "apps/console/src/app/products/[id]/page.tsx" apps/console/src/app/page.tsx
git commit -m "feat(console): /inventory page, adjust dialog, movement history, product-page panel"
```

---

### Task 6: Storefront availability — PDP sold-out state and JSON-LD

**Files:**
- Modify: `packages/core/src/catalog/queries.ts:77-87` (ProductDetail variants type), `:462-472` (getProductById mapping)
- Modify: `apps/storefront/src/lib/seo.ts:85-103` (docblock + sellable filter)
- Modify: `apps/storefront/src/components/VariantPicker.tsx`
- Test: `apps/storefront/tests/inventory-availability.integration.test.ts` (new)

**Interfaces:**
- Consumes: `getStockLevels(tx, variantIds)` (Task 2), `productVariants.tracksInventory` (Task 1).
- Produces: `ProductDetail.variants[]` gains `tracksInventory: boolean` and `available: number | null` (null = untracked = infinite). `productJsonLd` and `VariantPicker` consume them.

- [ ] **Step 1: Write the failing test**

Create `apps/storefront/tests/inventory-availability.integration.test.ts`. Copy the harness setup (admin connection, fixture creation, work-store `runDynamicRender`) from `description-sanitise.integration.test.ts` — same idiom, same cleanup contract. Fixtures: one active product with two active variants — one `tracks_inventory = true` with a `stock_levels` row at 0 (insert the location + level rows directly with the admin connection, like the isolation suite's `mkStock`), one untracked. **Give the two variants distinct `options` values** (`{"Size":"M"}` / `{"Size":"L"}`, bound `::text::jsonb` — the bare-client jsonb trap) — `product_variants_option_combo_key` collides on two `{}` rows, and the product also needs a matching `product_options`/`product_option_values` axis only if the test renders the picker, which it does not.

The assertions:

```ts
// 1. The cached PDP read carries availability.
const product = await runDynamicRender(() => getCachedProduct(tenantId, productId));
const tracked = product!.variants.find((v) => v.sku === TRACKED_SKU)!;
const untracked = product!.variants.find((v) => v.sku === UNTRACKED_SKU)!;
expect(tracked.tracksInventory).toBe(true);
expect(tracked.available).toBe(0);
expect(untracked.tracksInventory).toBe(false);
expect(untracked.available).toBeNull();

// 2. JSON-LD: with BOTH variants active but only the untracked one in
// stock, the product is InStock; with the untracked variant filtered
// out (pass a variants array holding only the tracked-at-zero one),
// availability flips to OutOfStock.
const ld = productJsonLd({ product: product!, url: "https://x.test/p", organizationName: "X", imageUrls: [] });
expect(JSON.stringify(ld)).toContain("schema.org/InStock");

const soldOut = { ...product!, variants: product!.variants.filter((v) => v.tracksInventory) };
const ldOut = productJsonLd({ product: soldOut, url: "https://x.test/p", organizationName: "X", imageUrls: [] });
expect(JSON.stringify(ldOut)).toContain("schema.org/OutOfStock");
```

(`productJsonLd` is pure — import it from `../src/lib/seo`. `getCachedProduct` from `../src/lib/catalog`.)

Run: `pnpm --filter @platform/storefront test:integration -- inventory-availability`
Expected: FAIL — `tracksInventory`/`available` are not on the variant shape.

- [ ] **Step 2: Extend `getProductById`**

In `packages/core/src/catalog/queries.ts`:

- Add to the `ProductDetail` variants type (after `isActive: boolean;`, line 86):

```ts
    tracksInventory: boolean;
    /** Summed on-hand for tracked variants; null = untracked = always available. */
    available: number | null;
```

- Import `getStockLevels` from `../inventory/server` at the top.
- In `getProductById`, after the `Promise.all` resolves, fetch levels for the tracked variants (inside the same `withTenant` transaction):

```ts
    const trackedIds = variantRows.filter((v) => v.tracksInventory).map((v) => v.id);
    const levels = await getStockLevels(tx, trackedIds);
```

- In the variant mapping (line ~462-472), after `isActive: v.isActive,`:

```ts
        tracksInventory: v.tracksInventory,
        available: v.tracksInventory ? (levels.get(v.id) ?? 0) : null,
```

- [ ] **Step 3: JSON-LD**

In `apps/storefront/src/lib/seo.ts`:

- Replace the last paragraph of the `productJsonLd` docblock (lines 85-89, "availability reflects only what the catalog currently models…") with:

```
 * `availability` now reflects the inventory ledger. Prices still come
 * from every ACTIVE variant — a sold-out product must keep its Offer
 * (price + OutOfStock), because an offer that vanishes reads to Google
 * as "no longer sold" rather than "temporarily out". A variant counts as
 * in stock when it is untracked (null available) or tracked above zero.
```

- Split the filter (line 99): prices from active variants, availability from in-stock ones. Replace:

```ts
  const sellable = product.variants.filter((v) => v.isActive);
  const prices = sellable.map((v) => v.pricePaise);
  const currency = sellable[0]?.currency ?? "INR";
  const availability =
    sellable.length > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";
```

with:

```ts
  const sellable = product.variants.filter((v) => v.isActive);
  const inStock = sellable.filter((v) => v.available === null || v.available > 0);
  const prices = sellable.map((v) => v.pricePaise);
  const currency = sellable[0]?.currency ?? "INR";
  const availability =
    inStock.length > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";
```

(Everything downstream — `low`/`high`/`offerCount` — stays on `sellable`, so a sold-out product keeps its priced Offer and only the availability flips.)

- [ ] **Step 4: The variant picker**

In `apps/storefront/src/components/VariantPicker.tsx`:

- Extend the local `Variant` type (after `isActive: boolean;`):

```ts
  tracksInventory: boolean;
  available: number | null;
};
```

(replacing the existing closing brace of the type.)

- Change the `sellable` memo so a tracked variant at zero is excluded — greyed chips come free through `reachableValues`, exactly like a variant that is switched off:

```ts
  const sellable = useMemo(
    () => variants.filter((v) => v.isActive && (v.available === null || v.available > 0)),
    [variants],
  );
```

- Distinguish "out of stock" from "does not exist" in the selection message. Above the `return`, add:

```ts
  // Active but out of stock ≠ nonexistent: the shopper who sees
  // "out of stock" waits or switches; one who sees "not available"
  // concludes the combination was never made.
  const activeMatch = matchVariant(
    variants.filter((v) => v.isActive),
    selection,
  );
```

and change the fallback branch of the selection message from:

```tsx
          <span className="muted">That combination is not available.</span>
```

to:

```tsx
          <span className="muted">
            {activeMatch ? "Out of stock." : "That combination is not available."}
          </span>
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `pnpm --filter @platform/storefront test:integration -- inventory-availability`
Expected: PASS.

- [ ] **Step 6: Full gate for the touched packages**

Run: `pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm test:integration`
Expected: clean; storefront integration 16 → 17-18 (record actuals); everything else at Task 4 counts. The build proves the PDP still compiles with the widened variant shape.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/catalog/queries.ts apps/storefront/src apps/storefront/tests
git commit -m "feat(storefront): PDP sold-out state and ledger-backed JSON-LD availability"
```

---

### Task 7: Docs, the full gate, and the live pass

**Files:**
- Modify: `PROJECT_STATUS.md` (last-updated, Phase 2 section, verified block, open items, one trap entry)
- Test: the entire matrix, then live HTTP

- [ ] **Step 1: Run the full gate**

```bash
export PATH="$HOME/.pnpm-shim:$PATH"
pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:integration
```

Expected: lint clean, 6/6 typecheck, 2/2 builds. Unit up from 325 (Task 3's CSV/bulk additions), integration up from 191 (db +1, core +10, console +9, storefront +1-2). RECORD THE ACTUAL NUMBERS and attribute every delta to its commit before writing them into the docs.

- [ ] **Step 2: Live pass**

```bash
pnpm infra:up && pnpm db:migrate
```

If `users` is empty (volume reset), add the staff row with the SQL in `README.md`. Serve production builds — console 3001, storefront 3010:

1. Console → a seeded acme product → tick "Tracked" on one variant → Save. The Inventory panel appears showing 0 on hand.
2. Storefront PDP for that product: the tracked variant reads **Out of stock** (or, single-variant product: JSON-LD `availability` is `OutOfStock` — check the page source's `application/ld+json`).
3. Console → Adjust → +5, note "opening count" → Save. `/inventory` lists the variant at 5.
4. Reload the PDP: in stock **immediately** — no TTL wait. (If it takes ~5 minutes, the purge is not reaching the storefront: check `STOREFRONT_INTERNAL_ORIGIN`/`INTERNAL_API_SECRET` in the console's env.)
5. Adjust → −5, note "sold at exhibition" → PDP flips to out of stock immediately; JSON-LD `OutOfStock`.
6. History page shows both movements, newest first, with notes and the staff user's name.
7. `/inventory?low=1` lists the variant (0 ≤ lowStockAt default 2) with the low badge.
8. An UNTRACKED variant on the same product renders unchanged throughout.

- [ ] **Step 3: Update PROJECT_STATUS.md**

- "Last updated" → the current date.
- Add a `Phase 2 — Commerce Core` row to the "Where things stand" table: `🚧 Started — inventory ledger shipped (see below)`.
- Add a "Verified <date> (inventory ledger, full, all green)" block after the last verified block: the gate's actual counts with every delta attributed to its commit, plus one paragraph on the live pass (immediate PDP flip, history, low-stock filter).
- The "Stock levels" open item: rewrite to "Ledger shipped — `stock_movements` + `stock_levels` + opt-in `tracks_inventory`, console adjust/history, PDP sold-out. Remaining: reservations (checkout task), bulk opening balances via CSV (designed follow-up)".
- Add one trap entry to "Traps already hit and fixed":

```
- **History tables must not FK their subjects with RESTRICT.** Tenant
  deletion cascades to variants and locations in unspecified order, so a
  RESTRICT FK from `stock_movements` would fail the cascade mid-flight —
  which is every test suite's cleanup. Ledger and audit rows reference by
  bare uuid (the audit_log precedent); write-time integrity comes from
  the visibility SELECT inside the one write door. And `stock_levels`'
  CHECK (on_hand >= 0) plus same-transaction upsert is what makes
  oversell impossible under concurrency — do not "optimise" the write
  into read-then-write.
```

- [ ] **Step 4: Commit**

```bash
git add PROJECT_STATUS.md
git commit -m "docs: record the inventory ledger as verified"
```

---

## Notes for the reviewer

- The spec is `docs/superpowers/specs/2026-08-15-inventory-ledger-design.md`. Coverage: schema/§1 → Task 1; domain/§2 → Task 2; console API+UI/§3 → Tasks 4-5; storefront/§4 → Task 6; CSV/§5 → Task 3; testing+live/§6 → every task's suite + Task 7.
- **Deliberate deviations from the spec, with reasons:**
  1. `stock_movements.variant_id`/`location_id` are bare uuids, not FKs — RESTRICT FKs break tenant-deletion cascades (Task 1 Step 1 amends the spec in place).
  2. The spec's `GET /api/inventory` and `GET /api/inventory/movements` routes are NOT built — the pages are server components reading through core directly, the settings-page precedent ("no GET route — the page reads server-side"). The adjust dialog needs only the POST.
  3. Pagination is limit/offset (the console-list idiom), not cursors.
  4. The movement history is a page (`/inventory/[variantId]`) linked from both the inventory list and the product panel, rather than an inline drawer — server-rendered, no client state.
- Enabling tracking writes NO movement; the variant reads as out of stock until an opening balance is set, and both the product-panel copy and the form copy say so.
- The concurrency test (Task 2) and the atomicity assertions (422 → zero ledger rows) are the two tests that keep the design honest — do not weaken them to make a run pass.



