# Handoff — Phase 2 opened: the inventory ledger

**Date:** 2026-08-15
**Session:** picked up the 2026-08-14 handoff, opened Phase 2 with the
inventory ledger (owner's choice at session start), and closed the
low-stock-threshold product decision the same day

---

## Goal

Execute the previous handoff's step 3: start Phase 2 (Commerce Core) with
blueprint §4.5 — an append-only `stock_movements` ledger as the source of
truth, a `stock_levels` projection, opt-in per-variant tracking, a console
adjust/history surface, and a minimal storefront sold-out state. Full
process: brainstorm → approved spec → 7-task plan → subagent-driven
execution with per-task reviews → final whole-branch review → merge.

Steps 1 and 2 of the old handoff (settings UI, containerization) were
already done by earlier sessions; real-VPS deployment remains blocked on
the owner acquiring a VPS/domain.

---

## Current state

**Merged to `master` and green.** Working tree clean, nothing deployed.

- `master` @ `36d9fb9`: the wave merged as `cf9b653` (a `--no-ff` merge of
  12 commits), then `e92a7b1` (lessons), then `36d9fb9` (the low-stock
  seeding decision, implemented inline post-merge with TDD).
- Gate at last commit: lint clean, typecheck 6/6, build 2/2, **332 unit
  tests (core 286, integrations 46), 218 integration (db 33, core 39,
  console 118, storefront 17, worker 11)** — was 325/191 at session start.
- Live pass on production builds: 7/8 steps verified, including the
  immediate PDP flip in both directions (purge working). Step 8 and two
  workarounds are disclosed in PROJECT_STATUS's verified block.
- Branch `phase2/inventory-ledger` deleted after merge;
  `phase1/completion`, `phase1/hardening`, `phase1/settings-ui`,
  `infra/dry-run` kept as rollback points.
- Migrations at 0006. Dev DB has exactly one tracked variant (acme,
  threshold 2 after the backfill).

---

## What was accomplished

Spec (`docs/superpowers/specs/2026-08-15-inventory-ledger-design.md`) and
plan (`docs/superpowers/plans/2026-08-15-inventory-ledger.md`), both
committed, then seven tasks, each implemented by a fresh subagent and
gated by an independent review:

1. **Schema** — `locations` (auto-provisioned default only),
   `stock_movements` (append-only BY GRANT, FK-less subject columns),
   `stock_levels` (CHECK `on_hand >= 0`), `product_variants.tracks_inventory`;
   isolation suite extended with fixtures on both tenants + an `it.each`
   append-only privilege test.
2. **Core module** (`@platform/core/inventory` + `/server`) —
   `recordMovement` (atomic ledger insert + projection write, reason
   auto-selection, idempotency with request fingerprint, 409 on the
   first-movement projection race, purge after commit), `getStockLevels`,
   `listInventory`, `getMovements`, `reconcileStockLevels`; 14-test
   integration suite including a genuine two-transaction concurrency race.
3. **Flag plumbing** — `tracksInventory` everywhere `isActive` flows:
   zod, form state, ProductForm checkbox, domain write, bulk merge,
   CSV column `variant_tracks_inventory` (blank-states-nothing, pinned at
   parse AND merge level with regression-verified tests).
4. **`POST /api/inventory/movements`** — through `handleCatalogWrite`
   with `inventory:write`, 8-test suite incl. purge stub (after-commit,
   none on refusal, exactly one on replay).
5. **Console UI** — `/inventory` (low-stock filter, pagination),
   `AdjustStock` dialog (idempotency key per opened dialog),
   `/inventory/[variantId]` history, product-page inventory panel,
   dashboard chip.
6. **Storefront** — `ProductDetail.variants[]` gained
   `tracksInventory`/`available`; VariantPicker sold-out state ("Out of
   stock." vs "not available"); JSON-LD availability flips while sold-out
   products KEEP their priced Offer.
7. **Docs + gate + live pass** — PROJECT_STATUS verified block
   (evidence-audited twice), new trap entry, `docs/PHASE2_FOLLOWUPS.md`.

Post-merge, the owner decided the open product question: **tracked
variants must surface in low stock** — the write layer now seeds
`DEFAULT_LOW_STOCK_AT` (2) on any variant saved tracked with a blank
threshold; migration 0006 backfilled; three new tests pin it.

---

## Files changed

39 files in the merge + 7 in the seeding commit. The map of where
behaviour lives:

| File | What it does |
| :--- | :--- |
| `packages/db/src/schema/inventory.ts` | The three tables. `stock_movements.variant_id`/`location_id` are bare uuids ON PURPOSE (see decisions). |
| `packages/db/src/schema/enums.ts` | `STOCK_MOVEMENT_REASONS` (`opening_balance`, `adjustment` — new reasons are migrations). |
| `packages/db/src/rls.ts` | `appendOnly` set now `{audit_log, stock_movements}`. |
| `packages/db/drizzle/0005_dashing_rogue.sql`, `0006_low_stock_backfill.sql` | Schema wave; hand-written threshold backfill (journal entry hand-added — no snapshot needed for data-only). |
| `packages/core/src/inventory/index.ts` | Pure barrel: `isLowStock`, `STOCK_ADJUSTMENT_MAX`, `DEFAULT_LOW_STOCK_AT`. Must never import `@platform/db`. |
| `packages/core/src/inventory/server.ts` | The single write door + all reads. 560 lines; the concurrency/idempotency/409 semantics live here. |
| `packages/core/src/catalog/writes.ts` | `VariantInput.tracksInventory`; the threshold-seeding rule in the variant columns block. |
| `packages/core/src/catalog/queries.ts` | `getProductById` joins levels for tracked variants (`available: number \| null`, null = untracked). |
| `packages/core/src/catalog/{bulk,csv,console-queries}.ts` | Flag through merge/CSV/console reads. |
| `apps/console/src/app/api/inventory/movements/route.ts` | The only HTTP writer of stock. |
| `apps/console/src/app/inventory/` | List page, `AdjustStock.tsx` (client), `[variantId]` history page. |
| `apps/console/src/app/products/[id]/page.tsx` | Inventory panel under the form. |
| `apps/storefront/src/components/VariantPicker.tsx`, `src/lib/seo.ts` | Sold-out UX; sellable/inStock split in JSON-LD. |
| `docs/PHASE2_FOLLOWUPS.md` | Deferred items + designed follow-ups. Read before re-diagnosing anything on it. |

Test suites: `packages/core/tests/inventory-ledger.integration.test.ts`
(14), `inventory.test.ts` (4), `apps/console/tests/inventory-movements`
(8) and `product-crud` (+3), `apps/storefront/tests/inventory-availability`
(1), plus CSV/bulk unit additions.

---

## Files in flight

**Nothing.** Tree clean, all committed to master, no remote. The SDD
workspace was deleted after the final review per process; its durable
content went to `docs/PHASE2_FOLLOWUPS.md` first.

---

## Failed attempts and mistakes

**My errors (the controller/planner's):**

- **The plan's projection upsert was defective.** PostgreSQL evaluates
  CHECK constraints on the candidate INSERT tuple BEFORE `ON CONFLICT`
  arbitration, so `INSERT … VALUES (delta) ON CONFLICT DO UPDATE` fails on
  any negative delta even when the updated value is legal. The Task 2
  implementer caught it; shipped as split INSERT/UPDATE. **Do not
  "simplify" back to the upsert.**
- **The plan's idempotency replay had no request fingerprint** — key reuse
  with a different variant/delta returned another movement as success.
  Only the final whole-branch review caught it. Fixed (422
  `idempotency_key_reuse`) with tests.
- **The Task 7 doc writer fabricated attribution prose** — correct counts,
  but delta attributions citing nonexistent test files, written from the
  plan's expectations instead of the tree. The runbook-fabrication lesson
  recurring in a new form. Caught by a reviewer explicitly instructed to
  diff doc claims against the evidence report claim-by-claim — give every
  verified-block reviewer that instruction (now in `tasks/lessons.md`).
- **My adjudication "lowStockAt null is designed behavior" was wrong** —
  a reviewer overturned it (the column's DEFAULT 2 signals intent; the
  live pass needed manual SQL). Disclosed, then resolved by the owner's
  seeding decision.
- The plan's prose said Task 4 had "9 tests" when its own suite code had 8
  `it()` blocks; and my first gate re-run after the merge "failed" only
  because my own grep pipeline swallowed the output and returned exit 1.
  Check the tail before diagnosing.

**Planning-time catch (do not undo):** RESTRICT/NO-ACTION FKs from
`stock_movements` to variants/locations would make tenant deletion fail
mid-cascade (Postgres cascade order is unspecified) — which is every
suite's cleanup. Hence bare uuids, the `audit_log.entity_id` precedent,
with write-time integrity via the visibility SELECT.

**Environment:** two API drops (connection lost, timeout) killed the
Task 7 agent before it started; resuming with explicit
finish-everything instructions worked both times. All ~20 sonnet/haiku
dispatches succeeded this session (no model-availability failures, unlike
2026-08-14).

**Live-pass workarounds (both disclosed in PROJECT_STATUS):** the
`__Host-` session cookie requires HTTPS, so local production-build
verification temporarily bypassed the `isProd` check in
`apps/console/src/lib/session.ts` (reverted, verified clean); the PUT
route's whole-set replace semantics soft-deleted the other variants when a
partial payload was sent, blocking live step 8.

---

## Key decisions

| Decision | Why, and what was rejected |
| :--- | :--- |
| **Opt-in tracking per variant**, default off | Existing catalogs untouched; merchants who don't count stock aren't forced to lie. Rejected: mandatory (everything reads sold-out), tenant-level toggle (too coarse). |
| **Default location only**, column from day one | Retrofitting NOT NULL onto append-only history means backfill guesswork. No CRUD until POS (Phase 5). |
| **Same-transaction projection write + CHECK guard** | Oversell impossible at the DB; logic stays in TypeScript. Rejected: trigger (invisible to core, owner-privilege semantics), SUM-on-read (no guard, contradicts §4.5). |
| **FK-less ledger subject columns** | See mistakes — cascade-order hazard + history must survive stray hard deletes. Spec amended in place. |
| **No GET API routes for inventory** | Server components read through core directly — the settings-page precedent. The spec's GETs were dropped as a documented deviation. |
| **First-movement projection race → 409 `concurrent_modification`** | The loser wrote nothing; retry succeeds. Chosen over internal retry loops. |
| **Seed `DEFAULT_LOW_STOCK_AT` on every tracked save with blank threshold** (owner-decided) | Tracked variants must surface in `/inventory?low=1`. "Tracked but never-low" is deliberately inexpressible — closest is threshold 0. Rejected: transition-only seeding (asymmetric, needs stored-state detection), read-time default (kills explicit null semantics). |
| **Replay answers 201 with `replayed: true`** | Distinguishing 200/201 would complicate the shared pipeline for no consumer. |

---

## What a fresh agent would otherwise rediscover

- Everything in the two previous handoffs still holds (pnpm shim, ports
  5442/6442/6389, 3000-taken, NODE_ENV override, withTenant, Drizzle
  traps, serialized `test:integration`).
- **Postgres checks CHECK constraints on the candidate INSERT tuple
  before ON CONFLICT arbitration** — the reason `recordMovement` is a
  split INSERT/UPDATE. Also in PROJECT_STATUS's trap list now.
- **Two variants on one product need distinct `options` in fixtures**
  (`product_variants_option_combo_key` collides on two `{}` rows), bound
  `::text::jsonb` on a bare postgres client.
- **`order_processor` is the role for inventory 403 tests** (has
  `inventory:read`, not `write`); catalog_manager HAS `inventory:write`.
- The multi-location revisit bundle is marked in code at the projection
  write: reason selection is per-variant, projection key
  per-(variant, location) — rework together in Phase 5.
- `docs/PHASE2_FOLLOWUPS.md` is the read-first list: resolved threshold
  decision, untested rendered sold-out state, VariantPicker UX notes,
  designed follow-ups (reservations, CSV quantity, order reasons).
- Local production-build console verification needs the `__Host-` cookie
  workaround or a real HTTPS front — budget for it in any live pass.
- The dev DB's only tracked variant is on acme with threshold 2; `users`
  may need the README staff SQL after any volume reset.

---

## Next steps

1. **Reservations** — Phase 2's next task: `stock_reservations`, the
   `reserved` column, `available = on_hand − reserved`. Brainstorm first;
   the spec's out-of-scope section and PHASE2_FOLLOWUPS frame it. This
   also decides whether backorders relax the CHECK.
2. **CSV bulk opening balances** — absolute-quantity-to-delta against the
   append-only ledger; needs its own design pass (dry-run preview,
   idempotency per row).
3. **Run this on a real VPS** — unchanged; blocked on the owner acquiring
   VPS + domain. The containerized stack and runbook are ready.
4. The PHASE2_FOLLOWUPS polish items when touching those files anyway —
   none worth a dedicated session.

**Blocked on people, unchanged:** CA/lawyer sign-off on BYOG payments,
TRAI DLT registration, WhatsApp Business verification, Ekart partner
agreement.
