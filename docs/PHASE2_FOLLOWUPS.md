# Phase 2 follow-ups

Triage from the inventory-ledger wave (branch `phase2/inventory-ledger`,
final whole-branch review 2026-08-15). Everything here was judged
ships-as-documented — nothing blocks the merge. Read this before
re-diagnosing anything on it.

## Deferred from the inventory ledger

- **Enabling tracking does not seed a low-stock threshold.** The console's
  zod default for `lowStockAt` is `null`, and the column's `DEFAULT 2` only
  fires on INSERTs that omit the column — so every console-created tracked
  variant has a null threshold, and null means *never low*. `/inventory?low=1`
  silently misses those variants, including one sitting at 0. Product
  decision pending: auto-seed a threshold when tracking flips on, or keep
  it explicit and surface the threshold in the adjust dialog. Decide before
  the next inventory-adjacent task.
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

- **Reservations** (`stock_reservations`, the `reserved` column,
  checkout holds) — `available` becomes `on_hand − reserved`.
- **CSV quantity / bulk opening balances** — absolute-quantity-to-delta
  semantics against the append-only ledger; the dry-run preview and
  idempotency need their own design pass.
- **Order/RTO movement reasons** — arrive with the order state machine as
  migrations extending `STOCK_MOVEMENT_REASONS`.
