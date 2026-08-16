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
- **Migrations 0005 and 0007 lack trailing newlines** — drizzle-kit
  artifact, cosmetic.

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
  `stock_levels` — revisit if merchants misread the badge). **Checkout consumer
  must handle both failure codes:** `consumeStock` can fail with `insufficient_stock`
  (stock gone) or `stock_held` (other references hold the remainder); `stock_held`'s
  message/path is adjustment-shaped — revisit the message when checkout lands.
- **CSV quantity / bulk opening balances** — absolute-quantity-to-delta
  semantics against the append-only ledger; the dry-run preview and
  idempotency need their own design pass.
- ~~**Order/RTO movement reasons**~~ — `sale` + `cancellation_restock` shipped
  with the commerce core (migration 0008); RTO reasons arrive with Phase 3.

## From the commerce-core wave (2026-08-16)

Triage from the Phase 2 completion build (branch `phase2/commerce-core`).
Everything here was judged ships-as-documented.

- **Carrier-mode serviceability is a stub** (contested review finding, 1-1):
  `shipping.pincode_policy` mode `carrier` throws `not_supported_yet` instead
  of the spec's cache-first registry check — the carrier registry has no live
  transport until Phase 3, so there is nothing real to consult. Wire it when
  the first carrier lands.
- **`payments_not_configured` consumes an order number**: the total (and thus
  the refusal) is only knowable after TX-A creates the order, which is then
  cancelled. Order numbers may gap (only INVOICE numbers are gap-free by law);
  recorded so nobody "fixes" the gap into a numbering bug.
- **Refund claim/record writes live in the worker job** (drizzle UPDATEs in
  `apps/worker/src/jobs/gateway-refund.ts`) rather than as named write-door
  functions in `payments/server` — behavior is pinned by tests; move
  `claimRefundForProcessing`/`recordRefundGatewayRef` into core when touched
  next. `markRefundProcessing` in core is now unused by the worker.
- **`InvoiceDocument` is console-owned**; the storefront guest page renders a
  reference-only invoice block (apps cannot import each other). A shared UI
  package is the clean fix if the guest page ever needs the full document.
- **D11 outbox gap stands**: a crash between commit and enqueue loses a
  domain-event notification (jobId = order_events.id makes the repair sweep a
  pure additive in Phase 4).
- **No credit notes for post-confirmation cancels** (invoice exists, refund
  recorded, no credit-note document) — Phase 3 owns credit notes with RTO.
- **Refund crashed between gateway call and record** → row stays `processing`
  with no gateway ref; the worker logs `refund.needs_reconciliation` and never
  re-calls the adapter (double-refund impossible). Phase 3 reconciliation
  owns the recovery.
- **Rate-limit constants live in storefront `buyer-api.ts`** — move beside
  `OTP_RATE_LIMITS` in core if core wants ownership.
- **Shipping GST uses the highest-value line's rate** as the principal-supply
  proxy — confirm with a CA before real merchants invoice (also flagged in
  the design spec's open questions).
- **Mock driver requires non-production NODE_ENV** (fail-closed) — the real-₹1
  exit criterion needs the owner's gateway keys on a real domain; everything
  up to the gateway hand-off is verified.
