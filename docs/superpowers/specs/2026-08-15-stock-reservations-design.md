# Design — Stock reservations (Phase 2, task 2)

**Date:** 2026-08-15
**Status:** Approved by the owner (scope, approach, and all four design sections)

The reservations half of blueprint §4.5: `available(variant) =
SUM(stock_movements.delta) − SUM(active stock_reservations.quantity)`. A
reservation is a short-lived hold a checkout session places on tracked stock
so that a buyer who is paying cannot lose the unit to a slower click. The
consumer — cart/checkout — does not exist yet; this task builds the primitive
fully tested (the carrier-framework and ledger precedent), designed against
the checkout-flow sketch below.

**The consumer contract (sketch, not built now):** buyer taps checkout →
storefront server code calls `holdStock` with the checkout session id and the
cart lines → buyer pays inside the hold window → payment confirmation calls
`consumeStock`, which turns the hold into ledger movements → abandonment calls
`releaseStock`, or the hold silently expires.

Scope decisions made by the owner at session start:

- **Reservations primitive now**, against the sketch above. Rejected: mapping
  the whole checkout slice first (reservations wouldn't merge this session);
  CSV opening balances instead (punts the harder design).
- **Holds are placed at checkout start**, not cart-add (high-abandonment carts
  must not starve inventory for browsers) and not payment-tap (two buyers
  filling address forms for the last unit is the worst-case UX for the loser).
- **No backorders. `on_hand >= 0` stays a hard CHECK.** Reservations add their
  own guard on top (holds cannot exceed on-hand). Backorders, if ever wanted,
  are a future explicit feature with their own design — not a relaxed
  constraint now.
- **Checkout is the only creator of reservations.** The console shows reserved
  counts read-only. Manual merchant holds ("set aside 2 for a WhatsApp
  customer") are a future feature; today a merchant can simulate one with a
  negative adjustment and a note.
- **Representation: computed on read, lock-guarded writes** (approach 1).
  A hold is *active* purely because `expires_at > now()`; "reserved" is
  summed live wherever levels are read. Expiry is a fact of reading, not a
  write event — no sweeper in the correctness path, no staleness window where
  expired holds block real buyers, no sweeper-vs-checkout races. Rejected:
  a denormalised `reserved` column on `stock_levels` with
  `CHECK (reserved <= on_hand)` (DB-enforced invariants and one-row reads,
  but expiry becomes a write a correctness-critical sweeper must perform,
  and until it runs expired holds lock real stock); holds as ledger
  movements with compensating entries (pollutes append-only history, still
  needs expiry writes, and the blueprint's formula explicitly keeps
  reservations out of the movements sum).
  **Documented deviation:** the ledger spec's out-of-scope note and
  PHASE2_FOLLOWUPS say "the `reserved` column"; the blueprint formula's
  `SUM(active stock_reservations)` is what this design implements. Approved
  by the owner with the approach choice.

---

## Facts the design rests on

Verified against the tree at `ab97f84` (paths cited so the plan can
re-verify):

- `recordMovement` (`packages/core/src/inventory/server.ts:183`) opens its
  own `withTenant` per call (`:203`) — so `consumeStock`, which needs several
  movements plus hold deletion in ONE transaction, requires the movement core
  to be extracted into an internal in-transaction function both entry points
  share. Public `recordMovement` behavior is unchanged.
- The projection write is a split INSERT/UPDATE (`server.ts:259-292`) because
  Postgres evaluates CHECK on the candidate INSERT tuple before ON CONFLICT
  arbitration (documented trap). Serialization is the `stock_levels` row
  lock the UPDATE takes implicitly; `holdStock` takes the same lock
  explicitly (`SELECT … FOR UPDATE`) since it updates nothing.
- Reasons are auto-selected — first movement `opening_balance`, else
  `adjustment` (`server.ts:243`); the reason CHECK lives in
  `packages/db/src/schema/enums.ts` (`STOCK_MOVEMENT_REASONS`) and new
  reasons are migrations by doctrine. `sale` joins the list this task.
- `stock_movements.reference_type` / `reference_id`
  (`packages/db/src/schema/inventory.ts:90-91`) exist and are unused —
  consume movements carry the hold's reference in them.
- The purge is issued after commit, fail-soft, skipped on replay
  (`server.ts:368-373`), via `purgeStorefrontCache` + `catalogPurgeTags`.
- `getStockLevels` (`server.ts:378`) sums raw on-hand; the PDP derives
  `available` from it (`packages/core/src/catalog/queries.ts:439-440,480`),
  and movement replay results use it for raw on-hand
  (`server.ts:167-171`). Those two meanings diverge in this task, so
  availability becomes a NEW read (`getAvailability`) and `getStockLevels`
  keeps its raw meaning.
- `listInventory` (`server.ts:412`) is a JOIN + GROUP BY, not a correlated
  SELECT-list subquery — the documented Drizzle trap (an interpolated outer
  column renders unqualified). The reserved join follows the same pattern.
- RLS is derived (`packages/db/src/rls.ts`): any data-plane table with
  `tenant_id` gets FORCE RLS + policy automatically; `appendOnly` at
  `rls.ts:144` is `{audit_log, stock_movements}` — `stock_reservations` is
  NOT append-only (it needs INSERT + DELETE).
- Migrations run in ONE transaction; the tree is at 0006, this task is 0007.
  Changing the reason CHECK means DROP CONSTRAINT + ADD CONSTRAINT in the
  migration file.
- The worker (`apps/worker/src/queues.ts`) has two queues and no repeatable
  jobs yet; its contract is "every payload carries tenantId" (`queues.ts:9`),
  so the tenant-less GC sweep iterates tenants from the control-plane
  `tenants` table and runs per-tenant `withTenant` deletes.
- Storefront tests asserting "the visitor now sees X" go through
  `runDynamicRender` (`apps/storefront/tests/next-cache-harness.ts`).
- Integration suites clean up what they create (tenants → users → plans) and
  `test:integration` is serialized db → core → apps via turbo `dependsOn`.

---

## 1. Schema — `stock_reservations` (in `packages/db/src/schema/inventory.ts`)

Live-only state, not history: a row exists exactly while a hold is live, is
deleted on release/consume, and stops counting the instant `expires_at`
passes even if the row lingers. Consumption history lives where history
already lives — the movement row, via its reference columns.

- `id` uuid PK (uuidv7), `tenant_id` → tenants (cascade).
- `variant_id` → product_variants **ON DELETE CASCADE**,
  `location_id` → locations **ON DELETE CASCADE** — real FKs, deliberately
  unlike the ledger: ephemeral state should die with its subject, there is
  no history to preserve, and no tenant-deletion hazard because every path
  is CASCADE, never RESTRICT.
- `quantity` integer NOT NULL, `CHECK (quantity > 0)`.
- `reference_type` text NOT NULL (`'checkout'` today; opaque to this module),
  `reference_id` uuid NOT NULL.
- `expires_at` timestamptz NOT NULL, `created_at` timestamptz NOT NULL
  default now().
- UNIQUE `(tenant_id, reference_type, reference_id, variant_id)` — one live
  hold per reference per variant; replace semantics rest on it.
- INDEX `(tenant_id, variant_id, expires_at)` — the active-sum path.
- **No `idempotency_key`** — replace semantics make one unnecessary (a hold
  is state, not an event). No `updated_at`, no soft delete.

The active predicate everywhere is `expires_at > now()`. Reserved for a
variant = `COALESCE(SUM(quantity) FILTER (WHERE active), 0)`.

RLS: joins `PLATFORM_TABLES`' data plane automatically (it carries
`tenant_id`); standard grants including DELETE. The isolation suite gains the
standard two-tenant fixtures for the table.

**Migration 0007:** create the table; drop and re-add
`stock_movements_reason_check` with `'sale'` added to
`STOCK_MOVEMENT_REASONS`.

## 2. Domain module — `packages/core/src/inventory/`

**`index.ts` (pure):** gains `RESERVATION_TTL_MINUTES = 15` (covers a
UPI/payment session; a platform constant, not per-tenant config) and the
hold/consume input/result types.

**`server.ts` — one lock protocol for every write.** Each write path locks
the variant's `stock_levels` row `FOR UPDATE` — the serialization point the
ledger already uses — and multi-line operations lock in **sorted variant-id
order** so concurrent multi-line holds cannot deadlock. A tracked variant
with no levels row has on-hand 0, refuses every hold, and needs no lock
(nothing to oversell). All comparisons and `expires_at` arithmetic happen in
Postgres (`now()`, `interval`) — one clock, no app/DB skew. The three
reservation functions take a minimal context (`tenantId`, `requestId?`), not
`WriteContext` — checkout has no staff actor.

- **`holdStock(ctx, { reference, lines })`** — `reference` is
  `{ type, id }`, `lines` is `[{ variantId, quantity }]`, quantities
  positive integers ≤ `STOCK_ADJUSTMENT_MAX`. One `withTenant` transaction,
  lines processed in sorted variant-id order:
  1. Load the line's variant with an explicit SELECT (tenancy; the
     `assertVisible` doctrine). Unknown or soft-deleted → `not_found`, the
     whole hold fails. Untracked → the line is *skipped* (untracked variants
     cannot run out) and reported back as `untracked`.
  2. Lock the `stock_levels` row FOR UPDATE. While holding the lock,
     opportunistically DELETE this variant's expired rows (free GC).
  3. Sum active holds for the variant **excluding this reference's own
     rows** (they are being replaced), and refuse if
     `quantity + reserved > on_hand`.
  4. If every tracked line fits: DELETE the reference's old rows, INSERT the
     new set with `expires_at = now() + interval '15 minutes'`.
  - Any tracked line failing rolls back the whole hold (all-or-nothing — a
    partial hold is a broken checkout) and the typed error
    (`insufficient_stock`, 422) lists each failing line with requested vs
    available. **Replace semantics:** re-holding the same reference replaces
    its hold set and refreshes the window — a double-clicked checkout button
    or an edited cart just works. Two *concurrent* holds for the same
    reference collide on the unique index; the loser maps the 23505 to a
    retryable 409 `concurrent_modification`, the ledger's projection-race
    precedent. Returns
    `{ lines: [{ variantId, quantity, status: 'held' | 'untracked' }], expiresAt }`.
- **`releaseStock(ctx, reference)`** — DELETE the reference's rows.
  Idempotent; releasing nothing is fine. No lock needed (releasing only ever
  frees stock).
- **`consumeStock(ctx, { reference, lines })`** — **lines come from the
  caller, not from the hold rows**: the order being created is the authority
  on what is being bought; the hold is a guarantee, not the data source
  (expired rows can be GC'd at any moment — if consume read quantities from
  rows, a GC racing a slow payment would erase them mid-flight). One
  transaction, sorted variant order, per line:
  1. Lock the levels row. DELETE the reference's row for this variant first
     — so the reserved sum no longer counts it — noting whether it was
     still active (`held`) or expired/absent (`unheld`).
  2. Write the movement through the shared in-transaction core:
     `delta = −quantity`, `reason: 'sale'`, `reference_type`/`reference_id`
     from the hold, `created_by_user_id` null (no staff actor),
     `note` null (automated movements carry references instead).
  3. If the stock is genuinely gone (an expired hold lost its unit), the
     `on_hand >= 0` CHECK refuses, the whole consume rolls back —
     `insufficient_stock` naming the lines — and the order layer decides
     what the buyer sees. Zero movements survive a failed consume.
  - Untracked lines are skipped (no movement — untracked stock is not
    counted). Returns per-line
    `{ variantId, status: 'held' | 'unheld' | 'untracked', movementId? }`.
  - **After commit:** one purge for all affected products through the
    existing fail-soft helper. **No audit rows** — for a sale the movement's
    reference IS the trail; `audit_log` is for staff actions and checkout
    has no staff actor.
- **`recordMovement` changes** (public contract unchanged, plus one new
  refusal): the ledger-insert + projection-write core is extracted into an
  internal in-transaction function `consumeStock` shares. The projection's
  INSERT-vs-UPDATE branch must key on **projection-row existence**, not on
  `reason === "opening_balance"` as today — a `sale` movement can be a
  variant's projection-creating write only in theory, but the branch
  condition stops being equivalent the moment a third reason exists. New
  guard: a
  negative delta that would take `on_hand` below the variant's active
  reserved sum is refused — **`stock_held`, 422**, message naming the held
  quantity and the soonest expiry (≤15 minutes away by construction).
  Without this, a merchant adjustment could yank stock a buyer is currently
  paying for, and their consume would fail after payment. Checked under the
  row lock the projection UPDATE takes; consume's own movements never trip
  it (their hold row is deleted in the same transaction before the movement,
  and the sum sees the delete).
- **`getAvailability(tx, variantIds)`** — NEW read:
  `Map<variantId, { onHand, reserved, available }>` where
  `available = GREATEST(on_hand − reserved, 0)`. `getStockLevels` keeps its
  raw on-hand meaning for movement results and the console product panel.
- **`listInventory`** gains `reserved` and `available` per row via a LEFT
  JOIN to a grouped active-holds subquery (the existing JOIN + GROUP BY
  pattern; no correlated subquery). The low-stock filter and threshold stay
  on **on-hand** — a physical-reorder signal; holds are ≤15-minute ephemera.
- `reconcileStockLevels` unchanged — reservations have no projection to
  reconcile.

## 3. Console

No new routes and no new pages — checkout is the only writer and it calls
core directly (the settings-page precedent; the read surfaces below ride
existing queries).

- **`/inventory` page:** columns become On hand | Reserved | Available
  (reserved shown as plain numbers; zero renders as "—"). Low-stock badge
  and filter unchanged (on-hand).
- **AdjustStock dialog:** surfaces the new `stock_held` 422 as the error
  message body, like `insufficient_stock` today.
- `POST /api/inventory/movements` is behaviorally unchanged; it cannot
  submit `reason: 'sale'` (reason was never client-supplied).

## 4. Storefront

- `getProductById` swaps `getStockLevels` for `getAvailability`:
  `ProductDetail.variants[].available` keeps its shape (`null` = untracked)
  but now subtracts active holds, so a full hold on the last unit reads as
  sold out. VariantPicker and JSON-LD are unchanged — they already consume
  `available`.
- **Holds do not purge.** Creating, releasing, or expiring a hold sends no
  storefront purge; displayed availability can lag by up to the cache TTL
  (300s) in the rare window where a hold flips it. Deliberate: expiry has no
  event to hook a purge onto (the point of expiry-on-read), hold churn would
  hammer the cache during sales, and correctness never depends on display —
  `holdStock` enforces truth transactionally at checkout. Consume purges via
  the movement path, which already does.

## 5. Worker — reservation GC

A repeatable BullMQ job (daily) — the worker's first repeatable job. It
iterates tenants from the control-plane `tenants` table and, per tenant
inside `withTenant`, deletes reservations expired for more than 24 hours,
logging the count. **Hygiene only**: correctness never depends on it running
(expired rows already do not count; `holdStock` also GCs opportunistically).
It exists so abandoned-checkout rows do not accumulate forever once checkout
creates real volume.

## 6. Testing, gate, docs

**Unit:** TTL constant exported; hold/consume input validation shapes.

**Integration — core** (standard harness; fixtures insert expired rows
directly rather than sleeping):

1. Hold happy path: rows created, `getAvailability` drops, on-hand
   untouched; release restores; expiry (fixture-expired row) restores
   without any write.
2. Refusal lists exactly the failing lines with requested vs available;
   nothing is held (all-or-nothing).
3. Replace semantics: re-holding the same reference with a different set
   replaces it and refreshes `expires_at`; the old set does not count
   against the new one (a reference can re-hold its own units).
4. Untracked lines skipped and reported; unknown variant fails the hold
   with `not_found`.
5. **Concurrency:** two parallel `withTenant` transactions holding the last
   unit — exactly one succeeds (the genuine two-transaction race, ledger
   -suite style).
6. Consume held path: hold rows gone, one `sale` movement per line with the
   reference carried, on-hand reduced, `reconcileStockLevels` clean.
7. Consume unheld-but-free path: expired hold, stock still there → movement
   written, status `unheld`.
8. Consume stolen path: expired hold, stock taken → whole consume rolls
   back, **zero movements survive**, `insufficient_stock`.
9. Adjustment below active reserved → `stock_held`; the same adjustment
   succeeds once the hold is expired (fixture) — and opportunistic GC
   removed the expired row on the next hold.
10. `getMovements` renders a `sale` movement correctly: reason, the carried
    reference, no note, no actor name.

**Integration — db:** isolation fixtures for `stock_reservations` on both
tenants (standard shape).

**Integration — console:** `/inventory` query returns reserved/available;
the movements route surfaces `stock_held` as 422 with the message.

**Integration — storefront:** PDP availability under an active hold (sold
out via `runDynamicRender`) and after fixture-expiry (available again). Since
holds do not purge, the test controls cache fill explicitly — fresh cache key
or manual purge between renders, not TTL waits.

**Integration — worker:** the GC job deletes long-expired rows, leaves
active ones and other tenants' rows alone.

**Gate:** full matrix (lint, typecheck, build, unit, integration), counts
reconciled against commits in PROJECT_STATUS — every verified-block reviewer
instructed to diff doc claims against the evidence report claim-by-claim.

**Live verification** (production builds, both apps): with a tracked variant
at 2 on-hand, hold 2 via a script through core → PDP flips to sold out after
cache TTL or a forced re-render; consume → history shows `sale` movements
with reference; `/inventory` shows reserved during the hold; a negative
adjustment during an active hold is refused with the `stock_held` message in
the dialog.

**Docs:** PROJECT_STATUS verified block + the stock open-item flips to
"ledger + reservations shipped; CSV opening balances pending";
PHASE2_FOLLOWUPS updates (reservations done, the reserved-column deviation
noted); `tasks/lessons.md` only if something earns an entry.

---

## Out of scope

- **Cart, checkout, orders, payments** — the consumers; the sketch above is
  a contract, not a commitment to build them this task.
- **Manual console holds** — future feature; negative adjustment + note is
  the workaround.
- **Backorders** — decided against; would need its own design.
- **Per-tenant TTL configuration** — the 15-minute constant until a merchant
  asks.
- **Purge on hold churn** — deliberate non-goal, see §4.
- **Order/RTO movement reasons beyond `sale`** — arrive with the order state
  machine.
- **Low-stock on available instead of on-hand** — revisit if merchants
  misread the badge.
- **Multi-location** — Phase 5; `location_id` is recorded (default location)
  so the retrofit is data-complete.
