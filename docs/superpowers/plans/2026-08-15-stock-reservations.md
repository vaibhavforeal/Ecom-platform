# Stock Reservations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reservations half of blueprint §4.5 — checkout holds in a `stock_reservations` table, computed-on-read availability (`available = on_hand − SUM(active holds)`), a `sale` movement reason, hold-aware guardrails on adjustments, read surfaces in console and storefront, and a hygiene-only GC job.

**Architecture:** One new data-plane table with real CASCADE FKs (live-only state, not history). A hold is *active* purely because `expires_at > now()` — expiry is a fact of reading, so no sweeper sits in the correctness path. All write paths serialize on the `stock_levels` row lock the ledger already uses (`SELECT … FOR UPDATE`, sorted variant order for multi-line). The movement core is extracted from `recordMovement` into a module-private in-transaction function that `consumeStock` shares. Spec: `docs/superpowers/specs/2026-08-15-stock-reservations-design.md`.

**Tech Stack:** Next 16.3.0 (App Router, Turbopack), Drizzle + postgres.js, zod 3, BullMQ 5, vitest integration tests against real Postgres.

## Global Constraints

- Work on branch `phase2/stock-reservations`, created from `master` before Task 1.
- `pnpm` is NOT on PATH in a plain shell. Run `export PATH="$HOME/.pnpm-shim:$PATH"` first in every shell. Run all pnpm commands from the repo root `D:\Software Ideas\Ecommerce Website`.
- Ports are non-default on purpose: Postgres `5442`, PgBouncer `6442`, Redis `6389`. Port 3000 is taken — storefront serves on `3010`, console on `3001`. Do not "fix" any of this.
- Integration tests need Docker up: `pnpm infra:up`, then `pnpm db:migrate`. `pnpm test:integration` is serialized by turbo — always run from the root.
- **Baseline counts before this plan:** 332 unit (core 286, integrations 46); 218 integration (db 33, core 39, console 118, storefront 17, worker 11). Record ACTUAL numbers at every gate; never copy expectations into docs unverified.
- Relative imports are extensionless repo-wide. No new npm dependencies.
- Drizzle operators (`sql`, `and`, `eq`, `inArray`, `isNull`, `asc`, `desc`, `gt`, `lt`, …) are re-exported by `@platform/db` — core never imports drizzle-orm directly.
- The tenant id comes from the SESSION (console) or the caller's context (core); never from a payload.
- Purges are issued AFTER the transaction commits, never inside it, and never throw (`packages/core/src/catalog/purge.ts`, reads `STOREFRONT_INTERNAL_ORIGIN` + `INTERNAL_API_SECRET`).
- Audit rows are written INSIDE the transaction via `recordAudit(tx, tenantId, entry)` — but **sale movements write no audit rows** (spec §2: checkout has no staff actor; the movement's reference is the trail).
- Integration suites delete what they create, in order tenants → users → plans, tracking ids in `Set`s; env vars are restored BEFORE pools close (the worker-suite lesson).
- Permissions: owner/manager/catalog_manager hold `inventory:write`; **order_processor holds `inventory:read` only** — use it for 403 tests.
- One clock: `expires_at` arithmetic and comparisons happen in Postgres (`now()`, `make_interval`), never `Date.now()` — except where explicitly marked informational.
- **Implementer deviations are signal, not noise** (tasks/lessons.md 2026-08-15): if code in this plan fights the schema, the types, or a test you cannot make honest, STOP and report the deviation rather than forcing the plan's text. Reviewers of Tasks 2–3 must independently verify the named risks in those tasks, not take the plan's word.

---

### Task 1: Schema, `sale` reason, migration 0007, isolation coverage

`stock_reservations` + the enum addition + the reason-CHECK swap, with two-tenant isolation fixtures.

**Files:**
- Modify: `packages/db/src/schema/enums.ts:118` (the `STOCK_MOVEMENT_REASONS` block)
- Modify: `packages/db/src/schema/inventory.ts` (amend `stock_levels` doc comment; append `stockReservations`)
- Modify: `packages/db/tests/isolation.test.ts` (extend `mkStock`)
- Migration: generated `packages/db/drizzle/0007_*.sql` (inspected; reason-CHECK swap hand-added if drizzle-kit omits it)

**Interfaces:**
- Consumes: existing table patterns in `schema/inventory.ts`, `sqlLiteralList` from `./enums`.
- Produces: Drizzle table `stockReservations` (exported from `@platform/db` via `schema/index.ts`'s existing `export * from "./inventory"`), and `"sale"` in `STOCK_MOVEMENT_REASONS` / `StockMovementReason`. Tasks 2–6 import these.

- [ ] **Step 0: Branch**

```bash
git checkout -b phase2/stock-reservations master
```

- [ ] **Step 1: Add the `sale` reason**

In `packages/db/src/schema/enums.ts`, replace the `STOCK_MOVEMENT_REASONS` block (lines 111–119) with:

```ts
/**
 * Why stock moved. Deliberately minimal: order/RTO/POS reasons arrive as
 * migrations with their phases, and a new reason being a migration is a
 * feature — the CHECK constraint is the single source of truth.
 * `opening_balance` is chosen automatically for a variant's first
 * movement; everything merchant-initiated after that is `adjustment`.
 * `sale` is written ONLY by consumeStock (a consumed checkout hold) —
 * no route accepts a client-supplied reason.
 */
export const STOCK_MOVEMENT_REASONS = ["opening_balance", "adjustment", "sale"] as const;
export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];
```

- [ ] **Step 2: The `stock_reservations` table**

In `packages/db/src/schema/inventory.ts`, first amend the `stockLevels` doc comment — replace the sentence `No \`reserved\` column yet — that arrives with the reservations task, when \`available\` starts meaning on_hand − reserved.` (and its trailing `Until then \`available = on_hand\` (summed across locations; there is one).`) with:

```
 * Reservations deliberately do NOT live here: available means
 * on_hand − SUM(active stock_reservations), computed at read time by
 * @platform/core/inventory/server.getAvailability — a hold expires by
 * being read as expired, never by a write.
```

Then append at the end of the file:

```ts
/**
 * Checkout holds — live-only state, NOT history. A row exists exactly
 * while a hold is live: deleted on release/consume, and it stops
 * counting the moment expires_at passes even if it lingers (expiry is a
 * fact of READING — nothing has to run at expiry time). Consumption
 * history lives on stock_movements via reference_type/reference_id.
 *
 * Real CASCADE FKs, deliberately unlike the ledger: ephemeral state
 * should die with its subject, there is no history to preserve, and
 * every path is CASCADE, never RESTRICT, so tenant deletion cannot fail
 * mid-cascade. No idempotency_key: holdStock has replace semantics — a
 * hold is state, not an event.
 */
export const stockReservations = pgTable(
  "stock_reservations",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),

    quantity: integer("quantity").notNull(),

    /** Who holds: 'checkout' today; opaque to this module. */
    referenceType: text("reference_type").notNull(),
    referenceId: uuid("reference_id").notNull(),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live hold per reference per variant; replace semantics and the
    // concurrent-same-reference 409 both rest on this.
    uniqueIndex("stock_reservations_ref_variant_key").on(
      t.tenantId,
      t.referenceType,
      t.referenceId,
      t.variantId,
    ),
    // The active-sum path: WHERE variant_id = ? AND expires_at > now().
    index("stock_reservations_variant_idx").on(t.tenantId, t.variantId, t.expiresAt),
    check("stock_reservations_quantity_check", sql`${t.quantity} > 0`),
  ],
);
```

No `rls.ts` change: the table carries `tenant_id` and is not in `PLATFORM_TABLES`, so FORCE RLS + policy + standard grants (including DELETE — it is NOT append-only) are derived automatically.

- [ ] **Step 3: Generate and inspect the migration**

```bash
export PATH="$HOME/.pnpm-shim:$PATH"
pnpm --filter @platform/db generate
```

Inspect the new `packages/db/drizzle/0007_*.sql`. It must contain `CREATE TABLE "stock_reservations"` with the three FKs ON DELETE CASCADE, the unique index, the `(tenant_id, variant_id, expires_at)` index, and the quantity CHECK. **Then verify the reason CHECK**: the file must also swap the constraint —

```sql
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_reason_check";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason_check" CHECK ("reason" IN ('opening_balance', 'adjustment', 'sale'));
```

drizzle-kit's CHECK diffing is unreliable; if these two statements are missing, hand-append them to the same 0007 file exactly as above (hand-edited migrations are the established pattern — 0006 was entirely hand-written). No `CREATE INDEX CONCURRENTLY` anywhere (the migrator runs one transaction).

- [ ] **Step 4: Migrate**

```bash
pnpm db:migrate
```

Expected: 0007 applies; the RLS re-apply lists `stock_reservations` as tenant-scoped with standard grants (SELECT, INSERT, UPDATE, DELETE — unlike `stock_movements`).

Verify the CHECK took (this is the step that catches a silently-skipped hand edit):

```bash
docker exec -i $(docker ps -qf name=postgres) psql -U postgres -d platform -c \
  "INSERT INTO stock_movements (id, tenant_id, variant_id, location_id, delta, reason)
   VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), -1, 'sale');" \
  2>&1 | head -3
```

Expected: a foreign-key violation on `tenant_id` (the row is garbage) — NOT a `stock_movements_reason_check` violation. If it says `reason_check`, the swap did not apply. (Adapt the container name via `docker ps` if the filter misses; the dev DB name/user come from `.env`.)

- [ ] **Step 5: Isolation fixtures**

In `packages/db/tests/isolation.test.ts`, inside the existing `mkStock` helper (added by the ledger wave — it inserts a location, a movement, and a level), append after the `stock_levels` INSERT:

```ts
    await admin`
      INSERT INTO stock_reservations
        (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
      VALUES (${randomUUID()}, ${tenantId}, ${variant!.id}, ${loc!.id}, 1,
              'checkout', ${randomUUID()}, now() + interval '15 minutes')`;
```

The generic read/write isolation loops derive the table list from the schema, so rows on both tenants are all the new table needs. No append-only change: `stock_reservations` must keep DELETE (do NOT add it to the `it.each` append-only test).

- [ ] **Step 6: Run the db suite**

```bash
pnpm --filter @platform/db test:integration
```

Expected: PASS, same test count as baseline (33) — the loops gained a table, not a test. If `stock_reservations` appears in a LEAK failure, `pnpm db:migrate` did not re-apply RLS.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add packages/db
git commit -m "feat(db): stock_reservations — live-only checkout holds; sale joins the movement reasons"
```

---

### Task 2: Extract the movement core; guard adjustments against active holds

Refactor `recordMovement` so `consumeStock` (Task 3) can share the ledger-insert + projection-write inside one transaction, switch the projection branch to row existence, and add the `stock_held` refusal. Public behavior of `recordMovement` is otherwise unchanged — the existing ledger suite passing untouched is the proof.

**Named risks for the reviewer (verify independently, do not trust this plan):**
1. The projection branch must key on ROW EXISTENCE (UPDATE first, INSERT when no row), not `reason === "opening_balance"` — with `sale` in the enum the old condition stops meaning "first write".
2. The `stock_held` sum must run AFTER the projection write (so it sees the resulting on-hand) and must be inside the same transaction (rollback on refusal must leave zero ledger rows).
3. Two concurrent first movements must still map the projection-PK 23505 to the retryable 409 (`concurrent_modification`) — the UPDATE-first shape preserves this; check it wasn't lost.

**Files:**
- Modify: `packages/core/src/inventory/server.ts` (extract `applyMovement`; add `StockHeldError`; rewire `recordMovement`)
- Test: `packages/core/tests/inventory-ledger.integration.test.ts` (three additions)

**Interfaces:**
- Consumes: Task 1's `stockReservations` table and widened `StockMovementReason` from `@platform/db`.
- Produces (Task 3 relies on these exactly):
  - module-private `applyMovement(tx: Tx, args: ApplyMovementArgs): Promise<{ movementId: string; onHand: number }>` where `ApplyMovementArgs = { tenantId: string; variantId: string; productId: string; locationId: string; delta: number; reason: StockMovementReason; note: string | null; idempotencyKey: string | null; createdByUserId: string | null; referenceType: string | null; referenceId: string | null }`. Throws raw Postgres errors (callers map) and `StockHeldError`.
  - `export class StockHeldError extends AppError` — `code: "stock_held"`, `status: 422`, `details.issues` on path `delta`.
  - `recordMovement` public signature and `MovementResult` unchanged.

- [ ] **Step 1: Write the failing tests**

In `packages/core/tests/inventory-ledger.integration.test.ts`:

Add to the `let` block near the top:

```ts
let heldVariant: string;
```

Add at the end of `beforeAll`:

```ts
  heldVariant = await makeVariant(tenantA, true);
```

Add a helper next to `movementCount`:

```ts
async function insertHold(
  variantId: string,
  quantity: number,
  expiresOffsetSeconds: number,
): Promise<string> {
  const referenceId = randomUUID();
  const [loc] = await admin<{ id: string }[]>`
    SELECT id FROM locations WHERE tenant_id = ${tenantA} AND is_default`;
  await admin`
    INSERT INTO stock_reservations
      (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
    VALUES (${randomUUID()}, ${tenantA}, ${variantId}, ${loc!.id}, ${quantity},
            'checkout', ${referenceId}, now() + make_interval(secs => ${expiresOffsetSeconds}))`;
  return referenceId;
}
```

Add a new `describe` after the `recordMovement` one:

```ts
describe("recordMovement vs active holds", () => {
  it("a negative adjustment below active holds is refused with stock_held, atomically", async () => {
    await recordMovement(ctx(tenantA), { variantId: heldVariant, delta: 5, note: "opening" });
    await insertHold(heldVariant, 3, 900); // active for 15 minutes

    const before = await movementCount(heldVariant);
    await expect(
      recordMovement(ctx(tenantA), { variantId: heldVariant, delta: -3, note: "yank" }),
    ).rejects.toMatchObject({ code: "stock_held", status: 422 });
    expect(await movementCount(heldVariant)).toBe(before);
    expect(await reconcileStockLevels(tenantA)).toEqual([]);
  });

  it("an adjustment that leaves exactly the held quantity is allowed", async () => {
    // on-hand 5, held 3: dropping to 3 is legal (3 is not below 3).
    const result = await recordMovement(ctx(tenantA), {
      variantId: heldVariant,
      delta: -2,
      note: "boundary",
    });
    expect(result.onHand).toBe(3);
  });

  it("the refused adjustment succeeds once the hold has expired — with no other write", async () => {
    await admin`
      UPDATE stock_reservations SET expires_at = now() - interval '1 second'
      WHERE variant_id = ${heldVariant}`;
    const result = await recordMovement(ctx(tenantA), {
      variantId: heldVariant,
      delta: -3,
      note: "recount",
    });
    expect(result.onHand).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @platform/core test:integration -- inventory-ledger`
Expected: FAIL — the first new test's `-3` movement *succeeds* (no guard exists), so `rejects.toMatchObject` fails.

- [ ] **Step 3: Implement**

In `packages/core/src/inventory/server.ts`:

(a) Add `stockReservations` to the `@platform/db` import list.

(b) Add the error class after `InsufficientStockError`:

```ts
export class StockHeldError extends AppError {
  constructor(resultingOnHand: number, reserved: number, soonestExpiry: Date | null) {
    super({
      code: "stock_held",
      message: `Movement refused: on-hand would be ${resultingOnHand} with ${reserved} held by active checkouts (soonest expiry ${soonestExpiry?.toISOString() ?? "unknown"})`,
      status: 422,
      publicMessage: `Buyers are checking out with ${reserved} of these right now; stock cannot drop below what is held. Holds expire within 15 minutes.`,
      details: {
        issues: [
          { path: "delta", message: `${reserved} held by active checkouts — retry after the holds expire.` },
        ],
      },
    });
  }
}
```

(c) Add the shared core after `findByIdempotencyKey`:

```ts
type ApplyMovementArgs = {
  tenantId: string;
  variantId: string;
  productId: string;
  locationId: string;
  delta: number;
  reason: StockMovementReason;
  note: string | null;
  idempotencyKey: string | null;
  createdByUserId: string | null;
  referenceType: string | null;
  referenceId: string | null;
};

/**
 * The ledger insert + projection write, inside the CALLER's transaction.
 * Shared by recordMovement (adjustments) and consumeStock (sales) — the
 * only two writers. Throws raw Postgres errors (callers map them) and
 * StockHeldError.
 */
async function applyMovement(
  tx: Tx,
  args: ApplyMovementArgs,
): Promise<{ movementId: string; onHand: number }> {
  const [movement] = await tx
    .insert(stockMovements)
    .values({
      tenantId: args.tenantId,
      variantId: args.variantId,
      locationId: args.locationId,
      delta: args.delta,
      reason: args.reason,
      note: args.note,
      idempotencyKey: args.idempotencyKey,
      createdByUserId: args.createdByUserId,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
    })
    .returning({ id: stockMovements.id });

  // Projection: UPDATE first, INSERT when no row exists yet. Branches on
  // ROW EXISTENCE, not reason — with `sale` in the enum, "reason ===
  // opening_balance" stopped meaning "first write". UPDATE-first also
  // keeps negative values away from the CHECK-on-INSERT-tuple trap, and
  // two concurrent first movements still collide on the projection PK
  // (both see no row, both INSERT) — the caller maps that 23505 to 409.
  let onHand: number;
  const [updated] = await tx
    .update(stockLevels)
    .set({ onHand: sql`${stockLevels.onHand} + ${args.delta}`, updatedAt: new Date() })
    .where(
      and(
        eq(stockLevels.tenantId, args.tenantId),
        eq(stockLevels.variantId, args.variantId),
        eq(stockLevels.locationId, args.locationId),
      ),
    )
    .returning({ onHand: stockLevels.onHand });
  if (updated) {
    onHand = updated.onHand;
  } else {
    const [inserted] = await tx
      .insert(stockLevels)
      .values({
        tenantId: args.tenantId,
        variantId: args.variantId,
        locationId: args.locationId,
        onHand: args.delta,
      })
      .returning({ onHand: stockLevels.onHand });
    onHand = inserted!.onHand;
  }

  // A negative movement must not take on-hand below what active
  // checkouts hold — a buyer mid-payment must not lose their unit to an
  // adjustment. consumeStock deletes its own hold row in this same
  // transaction BEFORE calling here, so the sum already excludes it.
  if (args.delta < 0) {
    const [held] = await tx
      .select({
        reserved: sql<number>`coalesce(sum(${stockReservations.quantity}), 0)::int`.as("reserved"),
        soonest: sql<string | null>`min(${stockReservations.expiresAt})::text`.as("soonest"),
      })
      .from(stockReservations)
      .where(
        and(
          eq(stockReservations.variantId, args.variantId),
          sql`${stockReservations.expiresAt} > now()`,
        ),
      );
    const reserved = held?.reserved ?? 0;
    if (onHand < reserved) {
      throw new StockHeldError(onHand, reserved, held?.soonest ? new Date(held.soonest) : null);
    }
  }

  return { movementId: movement!.id, onHand };
}
```

(d) Rewire `recordMovement`: inside its `withTenant` callback, replace everything from the `const [movement] = await tx.insert(stockMovements)…` statement through the split INSERT/UPDATE projection block (the code ending `onHand = level!.onHand;` in the else branch, including the Phase-5 comment) with:

```ts
      const { movementId, onHand } = await applyMovement(tx, {
        tenantId: ctx.tenantId,
        variantId: input.variantId,
        productId: variant.productId,
        locationId: location.id,
        delta: input.delta,
        reason,
        note: input.note ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdByUserId: ctx.actorUserId,
        referenceType: null,
        referenceId: null,
      });
```

then keep `recordAudit` as-is and update the returned object to use `movementId` instead of `movement!.id`. The reason auto-selection (`prior ? "adjustment" : "opening_balance"`), the idempotency fast path and fingerprint checks, the catch-block error mapping, and the after-commit purge all stay exactly where they are. `StockHeldError` needs no catch-block work: it is an `AppError` with no pg code, so `pgError()` matches nothing and the final `throw err` re-throws it intact.

Move the Phase-5 multi-location comment (per-variant reason selection vs per-(variant,location) projection key) onto `applyMovement` so it isn't lost.

- [ ] **Step 4: Run the suite**

Run: `pnpm --filter @platform/core test:integration -- inventory-ledger`
Expected: PASS — every pre-existing test green (the refactor proof) plus the three new ones.

- [ ] **Step 5: Full core suites, typecheck, lint**

```bash
pnpm typecheck && pnpm lint && pnpm --filter @platform/core test && pnpm --filter @platform/core test:integration
```

Expected: clean; core integration 39 → 42.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/inventory/server.ts packages/core/tests/inventory-ledger.integration.test.ts
git commit -m "feat(core): extract applyMovement; adjustments respect active checkout holds (stock_held)"
```

---

### Task 3: The reservations module — holdStock / releaseStock / consumeStock / getAvailability

The primitive itself, TDD against a new integration suite. This is the concurrency-critical task.

**Named risks for the reviewer (verify independently, do not trust this plan):**
1. Locks: every tracked line's `stock_levels` row is locked `FOR UPDATE` in SORTED variant-id order BEFORE any fit check; a variant with no levels row is never lockable and must refuse every positive hold.
2. Replace semantics: the reference's old rows are DELETED before the fit sums run — a re-hold must not compete with itself, including lines the new set no longer carries.
3. consumeStock takes quantities from the CALLER's lines, never from the hold rows (GC can erase expired rows mid-payment), and deletes its own hold row BEFORE `applyMovement` so the `stock_held` guard doesn't count it.
4. A failed consume must leave ZERO sale movements (whole-transaction rollback) and send NO purge.

**Files:**
- Modify: `packages/core/src/inventory/index.ts` (constants + types)
- Modify: `packages/core/src/inventory/server.ts` (four exports + helpers)
- Test: `packages/core/tests/stock-reservations.integration.test.ts` (new)

**Interfaces:**
- Consumes: Task 2's `applyMovement` + `StockHeldError`; Task 1's `stockReservations`; existing `ensureDefaultLocation`, `getStockLevels`, `pgError`, `VariantNotFoundError`, `purgeStorefrontCache`, `catalogPurgeTags`.
- Produces (Tasks 4–5 and future checkout rely on these exact signatures):
  - `RESERVATION_TTL_MINUTES = 15`, `ReservationReference = { type: string; id: string }`, `HoldLineInput = { variantId: string; quantity: number }`, `HoldLineResult = { variantId: string; quantity: number; status: "held" | "untracked" }`, `ConsumeLineResult = { variantId: string; quantity: number; status: "held" | "unheld" | "untracked"; movementId?: string }` — all from the PURE barrel.
  - `ReservationContext = { tenantId: string; requestId?: string | null }` (server).
  - `holdStock(ctx: ReservationContext, input: { reference: ReservationReference; lines: HoldLineInput[] }): Promise<{ lines: HoldLineResult[]; expiresAt: Date }>`.
  - `releaseStock(ctx: ReservationContext, reference: ReservationReference): Promise<{ released: number }>`.
  - `consumeStock(ctx: ReservationContext, input: { reference: ReservationReference; lines: HoldLineInput[] }): Promise<{ lines: ConsumeLineResult[] }>`.
  - `getAvailability(tx: Tx, variantIds: string[]): Promise<Map<string, { onHand: number; reserved: number; available: number }>>` — EVERY requested id gets an entry (unlike `getStockLevels`).
  - `InsufficientAvailabilityError` (`code: "insufficient_stock"`, 422) with `readonly failedLines: { variantId: string; requested: number; available: number }[]`.

- [ ] **Step 1: Pure barrel additions**

Append to `packages/core/src/inventory/index.ts`:

```ts
/**
 * How long a checkout hold lives. Covers a UPI/payment session; a
 * platform constant, not per-tenant config, until a merchant asks.
 */
export const RESERVATION_TTL_MINUTES = 15;

/** Who holds stock. Opaque to the inventory module; 'checkout' today. */
export type ReservationReference = { type: string; id: string };

export type HoldLineInput = { variantId: string; quantity: number };

export type HoldLineResult = {
  variantId: string;
  quantity: number;
  status: "held" | "untracked";
};

export type ConsumeLineResult = {
  variantId: string;
  quantity: number;
  /** "unheld": the hold had lapsed but the stock was still free — the sale went through. */
  status: "held" | "unheld" | "untracked";
  movementId?: string;
};
```

- [ ] **Step 2: Write the failing suite**

Create `packages/core/tests/stock-reservations.integration.test.ts`. Fixture idiom copies `inventory-ledger.integration.test.ts` (admin migrator connection, tracked-id cleanup, `makeTenant`/`makeVariant`); the purge stub copies `apps/console/tests/inventory-movements.integration.test.ts` (env restored before pools close).

```ts
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { closeConnections, withTenant } from "@platform/db";
import {
  InsufficientAvailabilityError,
  VariantNotFoundError,
  consumeStock,
  getAvailability,
  getMovements,
  getStockLevels,
  holdStock,
  recordMovement,
  reconcileStockLevels,
  releaseStock,
} from "@platform/core/inventory/server";

/**
 * The reservation primitive's invariants against real Postgres: holds
 * count only while unexpired, replace semantics, all-or-nothing refusal,
 * the last-unit race, consume's three outcomes, the stock_held guard
 * protecting OTHER references, and opportunistic GC.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantA: string;
let tenantB: string;
let userA: string;
let locationA: string;

const createdTenants = new Set<string>();
const createdUsers = new Set<string>();
const createdPlans = new Set<string>();

let purgeServer: Server;
let received: { tags: string[]; tenantId: string }[] = [];
let savedOrigin: string | undefined;
let savedSecret: string | undefined;

function ctx() {
  return { tenantId: tenantA, requestId: "resv-test" };
}

function writeCtx() {
  return { tenantId: tenantA, actorUserId: userA, ip: null, userAgent: null, requestId: "resv-test" };
}

function ref(): { type: string; id: string } {
  return { type: "checkout", id: randomUUID() };
}

async function makeTenant(): Promise<string> {
  const slug = "resv-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"resv-" + randomUUID().slice(0, 8)}, 'Reservations test plan')
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
    VALUES (${randomUUID()}, ${tenantId}, ${"resv-product-" + randomUUID().slice(0, 8)}, 'active')
    RETURNING id`;
  const [variant] = await admin<{ id: string }[]>`
    INSERT INTO product_variants
      (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory)
    VALUES
      (${randomUUID()}, ${tenantId}, ${product!.id}, ${"RESV-" + randomUUID().slice(0, 8)},
       19900, 500, ${tracked})
    RETURNING id`;
  return variant!.id;
}

/** Seed on-hand through the real write door so reconcile stays meaningful. */
async function seed(variantId: string, quantity: number): Promise<void> {
  await recordMovement(writeCtx(), { variantId, delta: quantity, note: "seed" });
}

async function insertHold(
  variantId: string,
  quantity: number,
  expiresOffsetSeconds: number,
  referenceId = randomUUID(),
): Promise<string> {
  await admin`
    INSERT INTO stock_reservations
      (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
    VALUES (${randomUUID()}, ${tenantA}, ${variantId}, ${locationA}, ${quantity},
            'checkout', ${referenceId}, now() + make_interval(secs => ${expiresOffsetSeconds}))`;
  return referenceId;
}

async function holdRows(referenceId: string): Promise<{ variant_id: string; quantity: number }[]> {
  return admin<{ variant_id: string; quantity: number }[]>`
    SELECT variant_id, quantity FROM stock_reservations
    WHERE reference_type = 'checkout' AND reference_id = ${referenceId}`;
}

async function variantHoldCount(variantId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_reservations WHERE variant_id = ${variantId}`;
  return row!.n;
}

async function saleCount(variantId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_movements
    WHERE variant_id = ${variantId} AND reason = 'sale'`;
  return row!.n;
}

async function availabilityOf(variantId: string) {
  return withTenant(tenantA, async (tx) => {
    const map = await getAvailability(tx, [variantId]);
    return map.get(variantId)!;
  });
}

beforeAll(async () => {
  tenantA = await makeTenant();
  tenantB = await makeTenant();
  userA = randomUUID();
  createdUsers.add(userA);
  const phone = "+9197" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userA}, ${phone}, 'Resv tester')`;

  const [loc] = await admin<{ id: string }[]>`
    INSERT INTO locations (id, tenant_id, name, is_default)
    VALUES (${randomUUID()}, ${tenantA}, 'Default', true)
    RETURNING id`;
  locationA = loc!.id;

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
  process.env.INTERNAL_API_SECRET = "resv-purge-secret-4e71aa";
});

afterEach(() => {
  received = [];
});

afterAll(async () => {
  // Restore env BEFORE the pools close (the worker-suite lesson).
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

describe("holdStock", () => {
  it("holds tracked lines, skips untracked; availability drops while on-hand stands", async () => {
    const vA = await makeVariant(tenantA, true);
    const vU = await makeVariant(tenantA, false);
    await seed(vA, 5);

    const reference = ref();
    const result = await holdStock(ctx(), {
      reference,
      lines: [
        { variantId: vA, quantity: 2 },
        { variantId: vU, quantity: 1 },
      ],
    });

    expect(result.lines).toEqual([
      { variantId: vA, quantity: 2, status: "held" },
      { variantId: vU, quantity: 1, status: "untracked" },
    ]);
    // expiresAt comes from Postgres now(); allow generous skew either way.
    const msOut = result.expiresAt.getTime() - Date.now();
    expect(msOut).toBeGreaterThan(13 * 60_000);
    expect(msOut).toBeLessThan(16 * 60_000);

    expect(await availabilityOf(vA)).toEqual({ onHand: 5, reserved: 2, available: 3 });
    const raw = await withTenant(tenantA, (tx) => getStockLevels(tx, [vA]));
    expect(raw.get(vA)).toBe(5); // on-hand untouched by a hold
    expect((await holdRows(reference.id)).length).toBe(1); // no row for the untracked line

    const released = await releaseStock(ctx(), reference);
    expect(released.released).toBe(1);
    expect(await availabilityOf(vA)).toEqual({ onHand: 5, reserved: 0, available: 5 });
  });

  it("an expired hold stops counting with no write anywhere", async () => {
    const vB = await makeVariant(tenantA, true);
    await seed(vB, 3);
    const reference = ref();
    await holdStock(ctx(), { reference, lines: [{ variantId: vB, quantity: 2 }] });
    expect((await availabilityOf(vB)).available).toBe(1);

    await admin`
      UPDATE stock_reservations SET expires_at = now() - interval '1 second'
      WHERE reference_id = ${reference.id}`;

    expect(await availabilityOf(vB)).toEqual({ onHand: 3, reserved: 0, available: 3 });
    // The row still exists — expiry needed no write to take effect.
    expect((await holdRows(reference.id)).length).toBe(1);
  });

  it("refuses all-or-nothing, naming exactly the failing lines", async () => {
    const vOk = await makeVariant(tenantA, true);
    const vShort = await makeVariant(tenantA, true);
    await seed(vOk, 5);
    await seed(vShort, 1);

    const reference = ref();
    const attempt = holdStock(ctx(), {
      reference,
      lines: [
        { variantId: vOk, quantity: 2 },
        { variantId: vShort, quantity: 2 },
      ],
    });
    await expect(attempt).rejects.toBeInstanceOf(InsufficientAvailabilityError);
    await expect(attempt).rejects.toMatchObject({
      code: "insufficient_stock",
      failedLines: [{ variantId: vShort, requested: 2, available: 1 }],
    });
    expect((await holdRows(reference.id)).length).toBe(0); // vOk was NOT held
  });

  it("replace semantics: a re-hold does not compete with itself and refreshes the window", async () => {
    const vC = await makeVariant(tenantA, true);
    await seed(vC, 3);
    const reference = ref();

    const first = await holdStock(ctx(), { reference, lines: [{ variantId: vC, quantity: 2 }] });
    // 3 on hand, 2 already held by THIS reference: a competing sum would
    // refuse 3; replace semantics must allow it.
    const second = await holdStock(ctx(), { reference, lines: [{ variantId: vC, quantity: 3 }] });

    expect(second.expiresAt.getTime()).toBeGreaterThanOrEqual(first.expiresAt.getTime());
    expect(await holdRows(reference.id)).toEqual([{ variant_id: vC, quantity: 3 }]);
    expect((await availabilityOf(vC)).available).toBe(0);
  });

  it("fails the whole hold on an unknown or cross-tenant variant", async () => {
    const vMine = await makeVariant(tenantA, true);
    const vTheirs = await makeVariant(tenantB, true);
    await seed(vMine, 5);

    const reference = ref();
    await expect(
      holdStock(ctx(), {
        reference,
        lines: [
          { variantId: vMine, quantity: 1 },
          { variantId: vTheirs, quantity: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(VariantNotFoundError);
    expect((await holdRows(reference.id)).length).toBe(0);
  });

  it("two concurrent holds for the last unit: exactly one wins", async () => {
    const vRace = await makeVariant(tenantA, true);
    await seed(vRace, 1);

    const results = await Promise.allSettled([
      holdStock(ctx(), { reference: ref(), lines: [{ variantId: vRace, quantity: 1 }] }),
      holdStock(ctx(), { reference: ref(), lines: [{ variantId: vRace, quantity: 1 }] }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      InsufficientAvailabilityError,
    );
    expect(await variantHoldCount(vRace)).toBe(1);
  });

  it("opportunistically sweeps the variant's expired rows while holding the lock", async () => {
    const vGc = await makeVariant(tenantA, true);
    await seed(vGc, 5);
    await insertHold(vGc, 1, -3600);
    await insertHold(vGc, 2, -7200);
    expect(await variantHoldCount(vGc)).toBe(2);

    await holdStock(ctx(), { reference: ref(), lines: [{ variantId: vGc, quantity: 1 }] });
    expect(await variantHoldCount(vGc)).toBe(1); // only the new live row remains
  });

  it("rejects empty lines, non-positive and duplicate quantities as invalid_payload", async () => {
    const vV = await makeVariant(tenantA, true);
    await seed(vV, 5);
    for (const lines of [
      [],
      [{ variantId: vV, quantity: 0 }],
      [{ variantId: vV, quantity: -1 }],
      [{ variantId: vV, quantity: 1.5 }],
      [
        { variantId: vV, quantity: 1 },
        { variantId: vV, quantity: 2 },
      ],
    ]) {
      await expect(holdStock(ctx(), { reference: ref(), lines })).rejects.toMatchObject({
        status: 422,
        code: "invalid_payload",
      });
    }
  });
});

describe("consumeStock", () => {
  it("consume held: sale movements carry the reference; rows gone; reconcile clean; ONE purge", async () => {
    const vSell = await makeVariant(tenantA, true);
    await seed(vSell, 4);
    const reference = ref();
    await holdStock(ctx(), { reference, lines: [{ variantId: vSell, quantity: 2 }] });
    received = [];

    const result = await consumeStock(ctx(), {
      reference,
      lines: [{ variantId: vSell, quantity: 2 }],
    });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.status).toBe("held");
    expect(result.lines[0]!.movementId).toBeTruthy();

    const raw = await withTenant(tenantA, (tx) => getStockLevels(tx, [vSell]));
    expect(raw.get(vSell)).toBe(2);
    expect((await holdRows(reference.id)).length).toBe(0);
    expect(await reconcileStockLevels(tenantA)).toEqual([]);

    const [movement] = await admin<
      { reason: string; reference_type: string; reference_id: string; note: string | null; created_by_user_id: string | null }[]
    >`
      SELECT reason, reference_type, reference_id, note, created_by_user_id
      FROM stock_movements WHERE variant_id = ${vSell} AND reason = 'sale'`;
    expect(movement).toMatchObject({
      reason: "sale",
      reference_type: "checkout",
      reference_id: reference.id,
      note: null,
      created_by_user_id: null,
    });

    const history = await getMovements(tenantA, vSell);
    expect(history[0]!.reason).toBe("sale");
    expect(history[0]!.createdByName).toBeNull();

    expect(received.length).toBe(1);
    expect(received[0]!.tenantId).toBe(tenantA);
  });

  it("consume unheld-but-free: the hold lapsed, the stock was still there, the sale goes through", async () => {
    const vLapse = await makeVariant(tenantA, true);
    await seed(vLapse, 2);
    const reference = ref();
    await insertHold(vLapse, 1, -60, reference.id);

    const result = await consumeStock(ctx(), {
      reference,
      lines: [{ variantId: vLapse, quantity: 1 }],
    });
    expect(result.lines[0]!.status).toBe("unheld");
    expect((await withTenant(tenantA, (tx) => getStockLevels(tx, [vLapse]))).get(vLapse)).toBe(1);
  });

  it("consume stolen: whole rollback, ZERO sale movements, NO purge", async () => {
    const vStolen = await makeVariant(tenantA, true);
    await seed(vStolen, 1);
    const reference = ref();
    await insertHold(vStolen, 1, -60, reference.id); // expired hold
    await recordMovement(writeCtx(), { variantId: vStolen, delta: -1, note: "walk-in sale" });
    received = [];

    await expect(
      consumeStock(ctx(), { reference, lines: [{ variantId: vStolen, quantity: 1 }] }),
    ).rejects.toMatchObject({ code: "insufficient_stock", status: 422 });
    expect(await saleCount(vStolen)).toBe(0);
    expect(received.length).toBe(0);
  });

  it("consume respects OTHER references' active holds via stock_held", async () => {
    const vGuard = await makeVariant(tenantA, true);
    await seed(vGuard, 3);
    await insertHold(vGuard, 3, 900); // someone else holds all three
    const reference = ref(); // this reference holds nothing

    await expect(
      consumeStock(ctx(), { reference, lines: [{ variantId: vGuard, quantity: 1 }] }),
    ).rejects.toMatchObject({ code: "stock_held", status: 422 });
    expect(await saleCount(vGuard)).toBe(0);
    expect(await variantHoldCount(vGuard)).toBe(1); // the other hold survives
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @platform/core test:integration -- stock-reservations`
Expected: FAIL at module load — `holdStock` (etc.) are not exported.

- [ ] **Step 4: Implement the server module**

Append to `packages/core/src/inventory/server.ts` (and add `stockReservations` to the `@platform/db` import if Task 2 hasn't already; import the new pure-barrel types: `import { RESERVATION_TTL_MINUTES, STOCK_ADJUSTMENT_MAX } from "./index"; import type { ConsumeLineResult, HoldLineInput, HoldLineResult, ReservationReference } from "./index";`):

```ts
/** Checkout has no staff actor — reservation entry points take this, not WriteContext. */
export type ReservationContext = { tenantId: string; requestId?: string | null };

export class InsufficientAvailabilityError extends AppError {
  readonly failedLines: { variantId: string; requested: number; available: number }[];

  constructor(lines: { variantId: string; requested: number; available: number }[]) {
    super({
      code: "insufficient_stock",
      message: `Hold refused: ${lines
        .map((l) => `${l.variantId} requested ${l.requested}, available ${l.available}`)
        .join("; ")}`,
      status: 422,
      publicMessage: "Some items are no longer available in the quantity requested.",
      details: {
        issues: lines.map((l) => ({
          path: l.variantId,
          message: `Requested ${l.requested}, only ${l.available} available.`,
        })),
      },
    });
    this.failedLines = lines;
  }
}

function validateLines(lines: HoldLineInput[]): void {
  const refuse = (message: string): never => {
    throw new AppError({
      code: "invalid_payload",
      message: `Reservation lines invalid: ${message}`,
      status: 422,
      publicMessage: "Some fields need attention.",
      details: { issues: [{ path: "lines", message }] },
    });
  };
  if (lines.length === 0) refuse("at least one line is required");
  if (lines.length > 100) refuse("at most 100 lines per hold");
  const seen = new Set<string>();
  for (const line of lines) {
    if (
      !Number.isInteger(line.quantity) ||
      line.quantity <= 0 ||
      line.quantity > STOCK_ADJUSTMENT_MAX
    ) {
      refuse(`quantity for ${line.variantId} must be a positive whole number`);
    }
    if (seen.has(line.variantId)) refuse(`duplicate line for ${line.variantId}`);
    seen.add(line.variantId);
  }
}

/** Visibility + tracking lookup for every line; throws on any unknown id. */
async function loadLineVariants(
  tx: Tx,
  variantIds: string[],
): Promise<Map<string, { productId: string; tracksInventory: boolean }>> {
  const rows = await tx
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      tracksInventory: productVariants.tracksInventory,
    })
    .from(productVariants)
    .where(and(inArray(productVariants.id, variantIds), isNull(productVariants.deletedAt)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of variantIds) {
    if (!byId.has(id)) throw new VariantNotFoundError(id);
  }
  return byId;
}

/**
 * Lock the tracked lines' stock_levels rows FOR UPDATE in SORTED
 * variant-id order — the deadlock discipline for multi-line operations.
 * A variant with no levels row has on-hand 0 and nothing to lock; every
 * positive request against it simply fails the fit check.
 */
async function lockLevels(
  tx: Tx,
  locationId: string,
  lines: HoldLineInput[],
): Promise<Map<string, number>> {
  const onHandBy = new Map<string, number>();
  for (const line of [...lines].sort((a, b) => (a.variantId < b.variantId ? -1 : 1))) {
    const [level] = await tx
      .select({ onHand: stockLevels.onHand })
      .from(stockLevels)
      .where(
        and(eq(stockLevels.variantId, line.variantId), eq(stockLevels.locationId, locationId)),
      )
      .for("update");
    onHandBy.set(line.variantId, level?.onHand ?? 0);
  }
  return onHandBy;
}

/**
 * Place (or replace) a reference's hold. All-or-nothing across the
 * lines; re-holding the same reference replaces its set and refreshes
 * the 15-minute window. Untracked lines are skipped — they cannot run
 * out. See the spec's §2 for the full semantics.
 */
export async function holdStock(
  ctx: ReservationContext,
  input: { reference: ReservationReference; lines: HoldLineInput[] },
): Promise<{ lines: HoldLineResult[]; expiresAt: Date }> {
  validateLines(input.lines);
  try {
    return await withTenant(ctx.tenantId, async (tx) => {
      const variants = await loadLineVariants(
        tx,
        input.lines.map((l) => l.variantId),
      );
      const location = await ensureDefaultLocation(tx, ctx.tenantId);

      const tracked = input.lines.filter((l) => variants.get(l.variantId)!.tracksInventory);
      const onHandBy = await lockLevels(tx, location.id, tracked);

      // Replace semantics: this reference's previous set stops counting
      // BEFORE the fit sums — a re-hold must not compete with itself.
      // Deleting (not excluding in the sum) also covers lines the new
      // set no longer carries.
      await tx
        .delete(stockReservations)
        .where(
          and(
            eq(stockReservations.referenceType, input.reference.type),
            eq(stockReservations.referenceId, input.reference.id),
          ),
        );

      const failures: { variantId: string; requested: number; available: number }[] = [];
      for (const line of tracked) {
        // Free GC while we hold this variant's row lock.
        await tx
          .delete(stockReservations)
          .where(
            and(
              eq(stockReservations.variantId, line.variantId),
              sql`${stockReservations.expiresAt} <= now()`,
            ),
          );
        const [held] = await tx
          .select({
            reserved: sql<number>`coalesce(sum(${stockReservations.quantity}), 0)::int`.as(
              "reserved",
            ),
          })
          .from(stockReservations)
          .where(
            and(
              eq(stockReservations.variantId, line.variantId),
              sql`${stockReservations.expiresAt} > now()`,
            ),
          );
        const available = Math.max((onHandBy.get(line.variantId) ?? 0) - (held?.reserved ?? 0), 0);
        if (line.quantity > available) {
          failures.push({ variantId: line.variantId, requested: line.quantity, available });
        }
      }
      if (failures.length > 0) throw new InsufficientAvailabilityError(failures);

      // Informational fallback for an all-untracked hold; rows get the
      // authoritative Postgres now() + TTL.
      let expiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60_000);
      if (tracked.length > 0) {
        const inserted = await tx
          .insert(stockReservations)
          .values(
            tracked.map((line) => ({
              tenantId: ctx.tenantId,
              variantId: line.variantId,
              locationId: location.id,
              quantity: line.quantity,
              referenceType: input.reference.type,
              referenceId: input.reference.id,
              expiresAt: sql`now() + make_interval(mins => ${RESERVATION_TTL_MINUTES})`,
            })),
          )
          .returning({ expiresAt: stockReservations.expiresAt });
        expiresAt = inserted[0]!.expiresAt;
      }

      return {
        lines: input.lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          status: variants.get(line.variantId)!.tracksInventory
            ? ("held" as const)
            : ("untracked" as const),
        })),
        expiresAt,
      };
    });
  } catch (err) {
    const pg = pgError(err);
    // Two CONCURRENT holds for one reference: both replaced the old set,
    // both inserted, the loser hits the unique index. Retryable.
    if (pg.code === "23505" && pg.text.includes("stock_reservations_ref_variant_key")) {
      throw new AppError({
        code: "concurrent_modification",
        message: "Another hold for this reference landed concurrently",
        status: 409,
        publicMessage: "Your checkout was updated at the same time. Please retry.",
      });
    }
    throw err;
  }
}

/** Drop a reference's holds. Idempotent — releasing nothing is fine. */
export async function releaseStock(
  ctx: ReservationContext,
  reference: ReservationReference,
): Promise<{ released: number }> {
  return withTenant(ctx.tenantId, async (tx) => {
    const deleted = await tx
      .delete(stockReservations)
      .where(
        and(
          eq(stockReservations.referenceType, reference.type),
          eq(stockReservations.referenceId, reference.id),
        ),
      )
      .returning({ id: stockReservations.id });
    return { released: deleted.length };
  });
}

/**
 * Turn a reference's hold into sale movements, atomically. Lines come
 * from the CALLER (the order being created is the authority) — never
 * from the hold rows, which GC may erase mid-payment. Per line the hold
 * row is deleted FIRST, so applyMovement's stock_held guard no longer
 * counts it; if the stock is genuinely gone the on_hand CHECK refuses
 * and the WHOLE consume rolls back (zero sale movements survive).
 */
export async function consumeStock(
  ctx: ReservationContext,
  input: { reference: ReservationReference; lines: HoldLineInput[] },
): Promise<{ lines: ConsumeLineResult[] }> {
  validateLines(input.lines);
  let currentLine: HoldLineInput | null = null;
  let outcome: { lines: ConsumeLineResult[]; productIds: string[] };
  try {
    outcome = await withTenant(ctx.tenantId, async (tx) => {
      const variants = await loadLineVariants(
        tx,
        input.lines.map((l) => l.variantId),
      );
      const location = await ensureDefaultLocation(tx, ctx.tenantId);

      const tracked = input.lines
        .filter((l) => variants.get(l.variantId)!.tracksInventory)
        .sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
      await lockLevels(tx, location.id, tracked);

      const results = new Map<string, ConsumeLineResult>();
      for (const line of input.lines) {
        if (!variants.get(line.variantId)!.tracksInventory) {
          results.set(line.variantId, {
            variantId: line.variantId,
            quantity: line.quantity,
            status: "untracked",
          });
        }
      }

      for (const line of tracked) {
        currentLine = line;
        const deleted = await tx
          .delete(stockReservations)
          .where(
            and(
              eq(stockReservations.referenceType, input.reference.type),
              eq(stockReservations.referenceId, input.reference.id),
              eq(stockReservations.variantId, line.variantId),
            ),
          )
          .returning({ expiresAt: stockReservations.expiresAt });
        // Informational only (app-clock comparison): "held" means the
        // buyer's guarantee was still standing when payment confirmed.
        const wasHeld = deleted.length > 0 && deleted[0]!.expiresAt.getTime() > Date.now();

        const applied = await applyMovement(tx, {
          tenantId: ctx.tenantId,
          variantId: line.variantId,
          productId: variants.get(line.variantId)!.productId,
          locationId: location.id,
          delta: -line.quantity,
          reason: "sale",
          note: null,
          idempotencyKey: null,
          createdByUserId: null,
          referenceType: input.reference.type,
          referenceId: input.reference.id,
        });
        results.set(line.variantId, {
          variantId: line.variantId,
          quantity: line.quantity,
          status: wasHeld ? "held" : "unheld",
          movementId: applied.movementId,
        });
      }
      currentLine = null;

      // Lines the order no longer carries: released — the order is the
      // authority on what was bought.
      await tx
        .delete(stockReservations)
        .where(
          and(
            eq(stockReservations.referenceType, input.reference.type),
            eq(stockReservations.referenceId, input.reference.id),
          ),
        );

      return {
        lines: input.lines.map((l) => results.get(l.variantId)!),
        productIds: [...new Set(tracked.map((l) => variants.get(l.variantId)!.productId))],
      };
    });
  } catch (err) {
    const pg = pgError(err);
    // The stolen path: an expired hold lost its unit to someone else.
    if (pg.code === "23514" && pg.text.includes("stock_levels_on_hand_check") && currentLine) {
      const line = currentLine;
      const available = await withTenant(ctx.tenantId, async (tx) => {
        const map = await getAvailability(tx, [line.variantId]);
        return map.get(line.variantId)?.available ?? 0;
      });
      throw new InsufficientAvailabilityError([
        { variantId: line.variantId, requested: line.quantity, available },
      ]);
    }
    throw err; // StockHeldError and everything else pass through intact
  }

  // After the commit, never inside it. Fail-soft. One purge for all
  // affected products.
  if (outcome.productIds.length > 0) {
    await purgeStorefrontCache(ctx.tenantId, catalogPurgeTags(ctx.tenantId, outcome.productIds));
  }
  return { lines: outcome.lines };
}

export type Availability = { onHand: number; reserved: number; available: number };

/**
 * on-hand, active-hold sum, and their clamped difference, per variant.
 * EVERY requested id gets an entry (unlike getStockLevels) — callers
 * need no ?? fallback. The PDP reads `available`; movement results and
 * the console product panel keep reading raw on-hand.
 */
export async function getAvailability(
  tx: Tx,
  variantIds: string[],
): Promise<Map<string, Availability>> {
  if (variantIds.length === 0) return new Map();
  const onHand = await getStockLevels(tx, variantIds);
  const reservedRows = await tx
    .select({
      variantId: stockReservations.variantId,
      reserved: sql<number>`coalesce(sum(${stockReservations.quantity}), 0)::int`.as("reserved"),
    })
    .from(stockReservations)
    .where(
      and(
        inArray(stockReservations.variantId, variantIds),
        sql`${stockReservations.expiresAt} > now()`,
      ),
    )
    .groupBy(stockReservations.variantId);
  const reservedBy = new Map(reservedRows.map((r) => [r.variantId, r.reserved]));

  const map = new Map<string, Availability>();
  for (const id of variantIds) {
    const on = onHand.get(id) ?? 0;
    const reserved = reservedBy.get(id) ?? 0;
    map.set(id, { onHand: on, reserved, available: Math.max(on - reserved, 0) });
  }
  return map;
}
```

- [ ] **Step 5: Run the suite**

Run: `pnpm --filter @platform/core test:integration -- stock-reservations`
Expected: PASS, 12 tests.

- [ ] **Step 6: Full core suites, typecheck, lint**

```bash
pnpm typecheck && pnpm lint && pnpm --filter @platform/core test && pnpm --filter @platform/core test:integration
```

Expected: clean; core integration 42 → 54. (Unit count unchanged: the pure barrel gained constants and types; input validation lives behind the server module and is pinned by the integration suite — a deliberate deviation from the spec's "unit: validation shapes" line, since the server module cannot load without the db package.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/inventory packages/core/tests/stock-reservations.integration.test.ts
git commit -m "feat(core): stock reservations — holdStock/releaseStock/consumeStock/getAvailability"
```

---

### Task 4: Console — reserved/available in `listInventory` and `/inventory`; `stock_held` through the route

The read surface and the one behavior change a merchant can hit from the console.

**Files:**
- Modify: `packages/core/src/inventory/server.ts` (`listInventory` + `InventoryRow`)
- Modify: `apps/console/src/app/inventory/page.tsx` (two columns)
- Test: `packages/core/tests/stock-reservations.integration.test.ts` (one describe)
- Test: `apps/console/tests/inventory-movements.integration.test.ts` (one test)

**Interfaces:**
- Consumes: Task 3's active-holds semantics; Task 2's `StockHeldError`.
- Produces: `InventoryRow` gains `reserved: number; available: number` — `page.tsx` renders them. Nothing else changes shape; the route contract is untouched (`stock_held` flows through the existing `AppError` → response mapping).

- [ ] **Step 1: Write the failing core tests**

Append to `packages/core/tests/stock-reservations.integration.test.ts` (import `listInventory` from the server barrel alongside the others):

```ts
describe("listInventory with holds", () => {
  it("carries reserved and available per row", async () => {
    const vList = await makeVariant(tenantA, true);
    await seed(vList, 4);
    await holdStock(ctx(), { reference: ref(), lines: [{ variantId: vList, quantity: 1 }] });

    const { items } = await listInventory(tenantA);
    const row = items.find((i) => i.variantId === vList)!;
    expect(row.onHand).toBe(4);
    expect(row.reserved).toBe(1);
    expect(row.available).toBe(3);
  });

  it("an expired hold contributes nothing", async () => {
    const vList2 = await makeVariant(tenantA, true);
    await seed(vList2, 2);
    await insertHold(vList2, 1, -60);

    const { items } = await listInventory(tenantA);
    const row = items.find((i) => i.variantId === vList2)!;
    expect(row.reserved).toBe(0);
    expect(row.available).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @platform/core test:integration -- stock-reservations`
Expected: FAIL — `InventoryRow` has no `reserved` (typecheck) or the values are `undefined`.

- [ ] **Step 3: Implement `listInventory`**

In `packages/core/src/inventory/server.ts`:

Add to `InventoryRow` (after `onHand: number;`):

```ts
  reserved: number;
  available: number;
```

Inside `listInventory`'s `withTenant` callback, define the active-holds subquery before the main query (a grouped subquery LEFT JOIN, one row per variant — NOT a correlated SELECT-list subquery, which is the documented Drizzle trap):

```ts
    const activeHolds = tx
      .select({
        variantId: stockReservations.variantId,
        reserved: sql<number>`sum(${stockReservations.quantity})::int`.as("reserved"),
      })
      .from(stockReservations)
      .where(sql`${stockReservations.expiresAt} > now()`)
      .groupBy(stockReservations.variantId)
      .as("active_holds");
```

Add to the main query's select object (after `onHand: onHand.as("on_hand"),`):

```ts
        reserved: sql<number>`coalesce(max(${activeHolds.reserved}), 0)::int`.as("reserved"),
```

(`max()` because the outer query GROUP BYs over the stock-levels join; the subquery contributes exactly one row per variant, so `max` is the identity — but the aggregate keeps Postgres's grouping rules satisfied.)

Add the join after `.leftJoin(stockLevels, …)`:

```ts
      .leftJoin(activeHolds, eq(activeHolds.variantId, productVariants.id))
```

And in the items mapping (after `onHand: r.onHand,`):

```ts
        reserved: r.reserved,
        available: Math.max(r.onHand - r.reserved, 0),
```

RLS scopes the subquery to the tenant automatically (`listInventory` already runs inside `withTenant`).

- [ ] **Step 4: Run the core tests**

Run: `pnpm --filter @platform/core test:integration -- stock-reservations`
Expected: PASS, 14 tests.

- [ ] **Step 5: The console columns**

In `apps/console/src/app/inventory/page.tsx`:

Replace the `<thead>` row:

```tsx
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th style={{ textAlign: "right" }}>On hand</th>
                <th style={{ textAlign: "right" }}>Reserved</th>
                <th style={{ textAlign: "right" }}>Available</th>
                <th></th>
              </tr>
```

And directly after the existing on-hand `<td>` (the one carrying the low badge — badge and `isLowStock` stay on on-hand), add:

```tsx
                  <td style={{ textAlign: "right" }} className="muted">
                    {row.reserved === 0 ? "—" : row.reserved}
                  </td>
                  <td style={{ textAlign: "right" }}>{row.available}</td>
```

`AdjustStock` needs NO change: `StockHeldError` carries `details.issues` on path `delta`, which the dialog's existing issue list already renders.

- [ ] **Step 6: The route test**

Append to the `describe` in `apps/console/tests/inventory-movements.integration.test.ts`:

```ts
  it("refuses an adjustment below active checkout holds with stock_held", async () => {
    sessionToken = ownerToken;
    // A fresh variant so this test owns its numbers (the suite's shared
    // variant carries state from earlier tests).
    const [v] = await admin<{ id: string }[]>`
      INSERT INTO product_variants
        (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory, options)
      VALUES (${randomUUID()}, ${tenantId}, ${productId},
              ${"INVR-" + randomUUID().slice(0, 8)}, 9900, 250, true,
              ${JSON.stringify({ Size: "S" })}::text::jsonb)
      RETURNING id`;
    const heldVariant = v!.id;

    const seeded = await postMovement({ variantId: heldVariant, delta: 5, note: "opening" });
    expect(seeded.status).toBe(201);

    const [loc] = await admin<{ id: string }[]>`
      SELECT id FROM locations WHERE tenant_id = ${tenantId} AND is_default`;
    await admin`
      INSERT INTO stock_reservations
        (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
      VALUES (${randomUUID()}, ${tenantId}, ${heldVariant}, ${loc!.id}, 4,
              'checkout', ${randomUUID()}, now() + interval '15 minutes')`;

    const before = await ledgerCount(heldVariant);
    const { status, data } = await postMovement({
      variantId: heldVariant,
      delta: -3, // 5 − 3 = 2, below the 4 held
      note: "yank",
    });
    expect(status).toBe(422);
    expect((data.error as { code: string }).code).toBe("stock_held");
    const issues = (data.error as { details: { issues: { path: string }[] } }).details.issues;
    expect(issues.some((i) => i.path === "delta")).toBe(true);
    expect(await ledgerCount(heldVariant)).toBe(before);
  });
```

- [ ] **Step 7: Run the console suite**

Run: `pnpm --filter @platform/console test:integration -- inventory-movements`
Expected: PASS; the file's count goes 8 → 9. (If the seeded POST's purge assertion interferes: it must not — `received` is reset by `afterEach`, and this test asserts no purge counts.)

- [ ] **Step 8: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add packages/core/src/inventory/server.ts packages/core/tests/stock-reservations.integration.test.ts apps/console/src/app/inventory/page.tsx apps/console/tests/inventory-movements.integration.test.ts
git commit -m "feat(console): reserved and available on /inventory; adjustments below holds refuse with stock_held"
```

---

### Task 5: Storefront — the PDP subtracts active holds

`getProductById` swaps `getStockLevels` for `getAvailability`. VariantPicker and JSON-LD change nothing — they already consume `available`.

**Files:**
- Modify: `packages/core/src/catalog/queries.ts` (import at top; two lines in `getProductById`, currently `:439-440` and `:480`)
- Test: `apps/storefront/tests/inventory-availability.integration.test.ts` (one test appended)

**Interfaces:**
- Consumes: Task 3's `getAvailability`.
- Produces: `ProductDetail.variants[].available` now means `max(on_hand − active holds, 0)` for tracked variants; `null` still means untracked. No shape change.

The console product page's inventory panel keeps reading raw on-hand through `getStockLevels` — deliberately unchanged (spec §2: the two meanings diverged, which is why `getAvailability` is a new read).

- [ ] **Step 1: Write the failing test**

Append to `apps/storefront/tests/inventory-availability.integration.test.ts` (inside the existing `describe`). Two fresh products — one with an active hold, one with an expired hold — so each needs only a single render and no cache gymnastics:

```ts
  it("active holds subtract from PDP availability; expired holds do not", async () => {
    const mkTracked = async (title: string, slug: string, onHand: number) => {
      const pid = randomUUID();
      await admin`
        INSERT INTO products (id, tenant_id, title, status, published_at)
        VALUES (${pid}, ${tenantId}, ${title}, 'active', now())`;
      await admin`
        INSERT INTO url_slugs (tenant_id, slug, entity_type, entity_id)
        VALUES (${tenantId}, ${slug}, 'product', ${pid})`;
      const vid = randomUUID();
      await admin`
        INSERT INTO product_variants (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory)
        VALUES (${vid}, ${tenantId}, ${pid}, ${"HOLD-" + slug}, 49900, 100, true)`;
      const [loc] = await admin<{ id: string }[]>`
        SELECT id FROM locations WHERE tenant_id = ${tenantId} AND is_default`;
      await admin`
        INSERT INTO stock_levels (tenant_id, variant_id, location_id, on_hand)
        VALUES (${tenantId}, ${vid}, ${loc!.id}, ${onHand})`;
      return { pid, vid, locId: loc!.id };
    };

    const heldOut = await mkTracked("Held Out Product", "held-out-product", 2);
    await admin`
      INSERT INTO stock_reservations
        (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
      VALUES (${randomUUID()}, ${tenantId}, ${heldOut.vid}, ${heldOut.locId}, 2,
              'checkout', ${randomUUID()}, now() + interval '15 minutes')`;

    const lapsed = await mkTracked("Lapsed Hold Product", "lapsed-hold-product", 2);
    await admin`
      INSERT INTO stock_reservations
        (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
      VALUES (${randomUUID()}, ${tenantId}, ${lapsed.vid}, ${lapsed.locId}, 1,
              'checkout', ${randomUUID()}, now() - interval '1 minute')`;

    const heldOutPdp = await runDynamicRender(() => getCachedProduct(tenantId, heldOut.pid));
    expect(heldOutPdp!.variants[0]!.available).toBe(0); // 2 on hand, 2 held

    const lapsedPdp = await runDynamicRender(() => getCachedProduct(tenantId, lapsed.pid));
    expect(lapsedPdp!.variants[0]!.available).toBe(2); // the hold lapsed; no write needed

    const ldOut = productJsonLd({
      product: heldOutPdp!,
      url: "https://x.test/p2",
      organizationName: "X",
      imageUrls: [],
    });
    expect(JSON.stringify(ldOut)).toContain("schema.org/OutOfStock");
  });
```

(The default location exists: the first test's fixtures created it in `beforeAll`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @platform/storefront test:integration -- inventory-availability`
Expected: FAIL — `available` is `0` on the lapsed product? No: FAIL on the held-out product, whose `available` still reads `2` (holds are not subtracted yet). The lapsed assertion passes either way; the held-out one is the teeth.

- [ ] **Step 3: Implement**

In `packages/core/src/catalog/queries.ts`:

- The import: `getStockLevels` is imported from `../inventory/server` near the top — replace it with `getAvailability` in that import statement.
- Line ~440: replace `const levels = await getStockLevels(tx, trackedIds);` with:

```ts
    const levels = await getAvailability(tx, trackedIds);
```

- Line ~480: replace `available: v.tracksInventory ? (levels.get(v.id) ?? 0) : null,` with:

```ts
        available: v.tracksInventory ? (levels.get(v.id)?.available ?? 0) : null,
```

(Keep the doc comment on `ProductDetail.variants[].available` honest — it currently says "Summed on-hand for tracked variants"; change that line to: `/** on_hand − active holds (clamped at 0) for tracked variants; null = untracked = always available. */`)

- [ ] **Step 4: Run the storefront suite**

Run: `pnpm --filter @platform/storefront test:integration`
Expected: PASS; storefront 17 → 18. The pre-existing test still passes — its tracked variant has no holds, so `getAvailability` returns the same numbers `getStockLevels` did.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add packages/core/src/catalog/queries.ts apps/storefront/tests/inventory-availability.integration.test.ts
git commit -m "feat(storefront): PDP availability subtracts active checkout holds"
```

---

### Task 6: Worker — the reservation GC job (hygiene only)

The worker's first repeatable job. Correctness never depends on it: expired rows already do not count anywhere; this keeps abandoned-checkout rows from accumulating forever.

**Files:**
- Modify: `packages/core/src/queues.ts:13-17` (one queue name)
- Modify: `apps/worker/src/queues.ts` (queue + close + contract note)
- Create: `apps/worker/src/jobs/sweep-reservations.ts`
- Modify: `apps/worker/src/index.ts` (worker + scheduler registration)
- Test: `apps/worker/tests/sweep-reservations.integration.test.ts` (new)

**Interfaces:**
- Consumes: `stockReservations`, `tenants`, `withPlatform`, `withTenant` from `@platform/db`.
- Produces: `sweepReservations(): Promise<{ tenantsSwept: number; deleted: number }>`; queue name `QUEUE_NAMES.maintenance`.

- [ ] **Step 1: The queue name**

In `packages/core/src/queues.ts`, add to `QUEUE_NAMES`:

```ts
  maintenance: "maintenance",
```

- [ ] **Step 2: Write the failing test**

Create `apps/worker/tests/sweep-reservations.integration.test.ts`:

```ts
import { randomUUID } from "node:crypto";

import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sweepReservations } from "../src/jobs/sweep-reservations";

/**
 * The GC sweep against real Postgres. The load-bearing assertion is the
 * per-tenant iteration: a cross-tenant DELETE on the app role would
 * silently match ZERO rows under RLS — the sweep must visit tenants.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

const createdTenants: string[] = [];
const createdPlans: string[] = [];

type Fixture = { tenantId: string; old: string; recent: string; active: string };
let a: Fixture;
let b: Fixture;

async function mkTenantWithHolds(): Promise<Fixture> {
  const slug = "gc-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"gc-" + randomUUID().slice(0, 8)}, 'GC test plan')
    RETURNING id`;
  createdPlans.push(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  createdTenants.push(tenant!.id);

  const [product] = await admin<{ id: string }[]>`
    INSERT INTO products (id, tenant_id, title, status)
    VALUES (${randomUUID()}, ${tenant!.id}, 'GC product', 'active')
    RETURNING id`;
  const [variant] = await admin<{ id: string }[]>`
    INSERT INTO product_variants
      (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory)
    VALUES (${randomUUID()}, ${tenant!.id}, ${product!.id},
            ${"GC-" + randomUUID().slice(0, 8)}, 9900, 100, true)
    RETURNING id`;
  const [loc] = await admin<{ id: string }[]>`
    INSERT INTO locations (id, tenant_id, name, is_default)
    VALUES (${randomUUID()}, ${tenant!.id}, 'Default', true)
    RETURNING id`;

  const mkHold = async (interval: string): Promise<string> => {
    const [row] = await admin<{ id: string }[]>`
      INSERT INTO stock_reservations
        (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
      VALUES (${randomUUID()}, ${tenant!.id}, ${variant!.id}, ${loc!.id}, 1,
              'checkout', ${randomUUID()}, now() + ${interval}::interval)
      RETURNING id`;
    return row!.id;
  };

  return {
    tenantId: tenant!.id,
    old: await mkHold("-2 days"),      // expired long ago → swept
    recent: await mkHold("-1 minute"), // expired, within the grace day → kept
    active: await mkHold("15 minutes"), // live → kept
  };
}

async function exists(id: string): Promise<boolean> {
  const [row] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_reservations WHERE id = ${id}`;
  return row!.n === 1;
}

beforeAll(async () => {
  a = await mkTenantWithHolds();
  b = await mkTenantWithHolds();
});

afterAll(async () => {
  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  await closeConnections();
});

describe("sweepReservations", () => {
  it("deletes only rows expired beyond the grace day, in EVERY tenant", async () => {
    const result = await sweepReservations();

    // Other suites' tenants may exist concurrently; assert our rows and
    // a lower bound, never exact totals.
    expect(result.deleted).toBeGreaterThanOrEqual(2);
    expect(result.tenantsSwept).toBeGreaterThanOrEqual(2);

    for (const f of [a, b]) {
      expect(await exists(f.old)).toBe(false);
      expect(await exists(f.recent)).toBe(true);
      expect(await exists(f.active)).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @platform/worker test:integration -- sweep-reservations`
Expected: FAIL at module load — `../src/jobs/sweep-reservations` does not exist.

- [ ] **Step 4: Implement**

Create `apps/worker/src/jobs/sweep-reservations.ts`:

```ts
import { sql, stockReservations, tenants, withPlatform, withTenant } from "@platform/db";

/**
 * Reservation GC — HYGIENE ONLY. An expired hold already counts nowhere
 * (every reader filters expires_at > now(), and holdStock sweeps its own
 * variant opportunistically); this job just keeps abandoned-checkout
 * rows from accumulating. Nothing breaks if it never runs.
 *
 * It iterates tenants because it must: a cross-tenant DELETE on the app
 * role silently matches ZERO rows — FORCE RLS with no tenant context
 * returns nothing rather than erroring. The grace day keeps rows
 * around long enough that a slow payment's consumeStock can still
 * report `unheld` honestly and a human can inspect yesterday's holds.
 */
export async function sweepReservations(): Promise<{ tenantsSwept: number; deleted: number }> {
  const tenantRows = await withPlatform((tx) => tx.select({ id: tenants.id }).from(tenants));

  let deleted = 0;
  for (const tenant of tenantRows) {
    const gone = await withTenant(tenant.id, (tx) =>
      tx
        .delete(stockReservations)
        .where(sql`${stockReservations.expiresAt} <= now() - interval '1 day'`)
        .returning({ id: stockReservations.id }),
    );
    deleted += gone.length;
  }
  return { tenantsSwept: tenantRows.length, deleted };
}
```

In `apps/worker/src/queues.ts`, append after `mediaQueue`:

```ts
/**
 * Platform maintenance — the ONE queue whose jobs carry no tenantId.
 * A sweep fans out across tenants itself (withTenant per tenant); see
 * jobs/sweep-reservations.ts for why a cross-tenant query cannot work.
 */
export const maintenanceQueue = new Queue<Record<string, never>>(
  QUEUE_NAMES.maintenance,
  { connection, defaultJobOptions },
);
```

and add `await maintenanceQueue.close();` inside `closeQueues` alongside the others. Also amend the file's CONTRACT comment: after the sentence ending `…is a cross-tenant bug waiting for a busy Diwali evening.` add: `The single exception is the maintenance queue, whose jobs are platform-wide by design and carry no tenantId.`

In `apps/worker/src/index.ts`:

- Imports: add `import { sweepReservations } from "./jobs/sweep-reservations";` and add `maintenanceQueue` to the `./queues` import.
- Append to the `workers` array:

```ts
  new Worker(
    QUEUE_NAMES.maintenance,
    async (job) => {
      log("job.start", { queue: job.queueName, jobId: job.id });
      const result = await sweepReservations();
      log("job.done", { jobId: job.id, ...result });
      return result;
    },
    { connection, concurrency: 1 },
  ),
```

- After the `log("worker.started", …)` line:

```ts
// Daily reservation GC. upsertJobScheduler is idempotent across
// restarts — one scheduler, however many times the worker boots.
maintenanceQueue
  .upsertJobScheduler("sweep-reservations", { every: 86_400_000 })
  .then(() => log("scheduler.registered", { job: "sweep-reservations" }))
  .catch((err) => log("worker.error", { queue: "maintenance", error: (err as Error).message }));
```

- [ ] **Step 5: Run the worker suite**

Run: `pnpm --filter @platform/worker test:integration`
Expected: PASS; worker 11 → 12.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add packages/core/src/queues.ts apps/worker
git commit -m "feat(worker): daily reservation GC — per-tenant sweep of long-expired holds"
```

---

### Task 7: Gate, live verification, docs

**Files:**
- Modify: `PROJECT_STATUS.md` (verified block; the stock open-item; trap list)
- Modify: `docs/PHASE2_FOLLOWUPS.md` (reservations done; deviation note)
- Modify: `tasks/lessons.md` (only if something earned an entry)

- [ ] **Step 1: The full gate**

```bash
export PATH="$HOME/.pnpm-shim:$PATH"
pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:integration
```

Record ACTUAL counts. Expectations (verify, never copy): unit 332 unchanged; integration 218 → ~238 — db 33 (unchanged), core 39 → 56, console 118 → 119, storefront 17 → 18, worker 11 → 12. Reconcile every delta against its commit before writing any of it into docs.

- [ ] **Step 2: Live verification (production builds)**

Bring up dev infra, build, and serve both apps as in previous waves (console 3001, storefront 3010; the `__Host-` cookie workaround from PROJECT_STATUS's 2026-08-15 block applies — budget for it and revert before committing).

Since holds have no HTTP surface (by design), drive them with a temp script through core. Create `scripts/tmp-live-holds.ts` at the repo root (DELETE after the pass — it must not be committed):

```ts
import { consumeStock, holdStock, releaseStock } from "@platform/core/inventory/server";

const [action, tenantId, variantId, qty] = process.argv.slice(2);
const reference = { type: "checkout", id: "3f000000-0000-4000-8000-00000000live" };
const lines = [{ variantId: variantId!, quantity: Number(qty ?? 1) }];

const run = async () => {
  if (action === "hold") console.log(await holdStock({ tenantId: tenantId! }, { reference, lines }));
  else if (action === "consume") console.log(await consumeStock({ tenantId: tenantId! }, { reference, lines }));
  else if (action === "release") console.log(await releaseStock({ tenantId: tenantId! }, reference));
  else throw new Error("action: hold | consume | release");
};
run().then(() => process.exit(0));
```

Run with the repo's env: `pnpm exec dotenv -e .env -- pnpm exec tsx scripts/tmp-live-holds.ts hold <tenantId> <variantId> 2` (adapt to however `scripts/` are invoked in this repo if a different runner is established — check `packages/db/package.json`'s migrate script for the idiom).

The pass, on the seeded acme tenant's tracked variant (threshold 2):

1. Set the variant's on-hand to 2 via the console adjust dialog.
2. `hold … 2` → console `/inventory` shows On hand 2 / Reserved 2 / Available 0.
3. PDP: after the storefront cache refills (no purge on holds — force it by waiting the TTL or touching the product via the console), the variant reads out of stock. Record which method was used.
4. In the console, attempt an adjustment of −1 → the dialog shows the `stock_held` message. Screenshot/copy the text.
5. `consume … 2` → PDP flips to OutOfStock **immediately** (consume purges); `/inventory` shows 0/—/0; the history page shows a `sale` movement with no actor.
6. Set on-hand back to 2, `hold … 2`, then `release` → `/inventory` back to 2/—/2 with no movement written (history unchanged).
7. Delete `scripts/tmp-live-holds.ts`; `git status` must be clean of it.

Record every command and its actual output for the docs step; the runbook-fabrication lesson applies in full.

- [ ] **Step 3: PROJECT_STATUS.md**

Add a "Verified 2026-08-15 (stock reservations, full, all green)" block following the house format: the gate matrix with actual counts, the count deltas reconciled per commit, the live-pass narrative with its limitations, and any workarounds disclosed. Flip the "Stock levels" open item to: ledger + reservations shipped; CSV opening balances remain. Add two trap entries:

- **A cross-tenant maintenance query on the app role silently does nothing.** FORCE RLS with no tenant context returns zero rows, not an error — so a "DELETE all expired holds" sweep must iterate tenants (`withPlatform` for the list, `withTenant` per tenant). The worker's GC job is the precedent.
- **`stock_reservations` expiry is read-side.** A hold stops counting the instant `expires_at` passes; nothing runs at expiry time, the GC is hygiene-only, and NO reader may drop the `expires_at > now()` filter "because the sweeper cleans up".

The reviewer of this task diffs every doc claim against the evidence report claim-by-claim (tasks/lessons.md 2026-08-15 — counts alone passing is not enough).

- [ ] **Step 4: PHASE2_FOLLOWUPS.md**

Under "Designed follow-up tasks", strike the reservations bullet as done (same style as the resolved threshold item), noting: shipped computed-on-read (the spec's documented deviation from "the `reserved` column" phrasing — the blueprint formula's `SUM(active …)` is what got built); the PDP does not purge on hold churn (deliberate, spec §4); low-stock stays keyed on on-hand (revisit if merchants misread the badge).

- [ ] **Step 5: Lessons**

Add an entry to `tasks/lessons.md` ONLY if this wave actually earned one (a planned-code defect an implementer caught, a review overturn, a fabrication catch). Do not pad.

- [ ] **Step 6: Commit**

```bash
git add PROJECT_STATUS.md docs/PHASE2_FOLLOWUPS.md tasks/lessons.md
git commit -m "docs: stock reservations verified block, followups, traps"
```

---

## Self-review (run before handing the plan to execution)

- **Spec coverage:** §1 schema → Task 1; §2 module (holdStock/releaseStock/consumeStock/getAvailability, applyMovement extraction, stock_held, listInventory) → Tasks 2–4; §3 console → Task 4; §4 storefront → Task 5; §5 worker → Task 6; §6 testing/gate/docs → per-task suites + Task 7. The spec's "unit: validation shapes" line is deliberately deviated (Task 3 Step 6 notes why).
- **Type consistency:** `ReservationContext`, `ReservationReference`, `HoldLineInput`, `HoldLineResult`, `ConsumeLineResult`, `Availability`, `ApplyMovementArgs` are each defined once and referenced by those exact names in Tasks 3–6. `failedLines` (not `lines`) is the error's structured field.
- **No placeholders:** every step carries the code or the exact command; the two "adapt to the repo" notes (Task 1 Step 4's psql container name, Task 7 Step 2's script runner) name precisely what to check and where.

