# Phase 2 follow-ups

Triage from the inventory-ledger wave (branch `phase2/inventory-ledger`,
final whole-branch review 2026-08-15). Everything here was judged
ships-as-documented — nothing blocks the merge. Read this before
re-diagnosing anything on it.

## Deferred from the inventory ledger

- ~~**Enabling tracking does not seed a low-stock threshold.**~~ **Resolved
  2026-08-15** (owner decision: tracked variants must surface in low stock).
  The write layer seeds `DEFAULT_LOW_STOCK_AT` (2, `@platform/core/inventory`)
  whenever a variant is saved tracked with a blank threshold — uniformly on
  every save, so "tracked but never-low" is deliberately inexpressible (the
  closest is a threshold of 0: low only at zero). Migration
  `0006_low_stock_backfill` fixed pre-existing rows; pinned by three tests in
  `apps/console/tests/product-crud.integration.test.ts`.
- **The rendered PDP sold-out state is untested.** The storefront
  integration test covers the query layer (`available` on `ProductDetail`)
  and the JSON-LD purity; VariantPicker's filter and "Out of stock." message
  were verified in the live pass only. A `runDynamicRender`-based render
  test would close it.
- **VariantPicker UX notes (product decisions, pre-existing shape):** a
  fully-sold-out multi-variant product initially shows "That combination is
  not available." until axes are picked (empty selection has no
  `activeMatch`); a no-axes product renders no picker at all
  (`axes.length === 0` returns null), so it has no visible sold-out state —
  and the picker is also the PDP's only price renderer for that case.
- **Multi-location revisit bundle (Phase 5).** Marked in code at the
  projection write (`packages/core/src/inventory/server.ts`): the reason
  auto-selection is per-variant while the projection key is
  per-(variant, location) — the `level!` UPDATE-path assumption, reason
  selection, and `stock_levels` keying need rework together when locations
  become real.
- **No explicit `changedFields` flip test for `tracks_inventory`** — the
  comparison clause exists (`bulk.ts`), the merge-level tests pin the
  dangerous direction; residual risk is a cosmetic dry-run-report omission.
- **0005 migration file lacks a trailing newline** — drizzle-kit artifact,
  cosmetic.

## Designed follow-up tasks (from the spec, not defects)

- ~~**Reservations**~~ **Shipped 2026-08-15** (branch `phase2/stock-reservations`).
  `stock_reservations` table + `sale` reason (migration 0007); `holdStock`,
  `releaseStock`, `consumeStock`, `getAvailability` in `@platform/core/inventory/server`;
  console `/inventory` Reserved/Available columns; PDP availability subtracts active
  holds; worker daily GC sweep. **Deviation from spec phrasing:** no physical
  `reserved` column exists — the projection is computed-on-read
  (`SUM(quantity) WHERE expires_at > now()`), matching the blueprint's formula
  §4.3. The console does not purge on hold churn (deliberate, spec §4). Low-stock
  stays keyed on on-hand (the availability projection isn't carried into
  `stock_levels` — revisit if merchants misread the badge).
- **CSV quantity / bulk opening balances** — absolute-quantity-to-delta
  semantics against the append-only ledger; the dry-run preview and
  idempotency need their own design pass.
- **Order/RTO movement reasons** — arrive with the order state machine as
  migrations extending `STOCK_MOVEMENT_REASONS`.
