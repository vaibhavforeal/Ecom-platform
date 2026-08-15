# Phase 2 Commerce Core — Build Spec (synthesized)

Synthesis of the design panel: base = `panel/design-minimal-diff.md` (winner),
with judge-mandated grafts from `panel/design-correctness.md` and
`panel/design-operator-ux.md`. Every contested point is resolved in §0.
Spec sources: PLATFORM_BLUEPRINT.md §3–§5.4, docs/PHASE2_FOLLOWUPS.md,
docs/design/CONVENTIONS_BRIEF.md (the brief binds every builder; when this
spec and the brief disagree, STOP and flag — do not improvise).

Locked decisions taken as given: BYOG payments (Razorpay-shaped adapter +
mock driver), webhook-first confirmation, tax-inclusive default, invoice
numbers via UPDATE..RETURNING on invoice_series inside the confirming tx,
BIGINT paise, UUIDv7, tenant RLS everywhere, order-line snapshots.

## What is explicitly NOT built in Phase 2

- Customer login / accounts / address books (guest checkout; lean
  `customers` row upserted by phone — needed for per-customer coupon limits
  and `first_order`).
- Credit notes / RTO reversal documents (`invoices.doc_type` union has room;
  cancel path stops at full refund pre-shipment). **Known limitation,
  documented for PROJECT_STATUS: any cancel after confirmation (prepaid or
  COD) leaves an issued invoice with no credit note until Phase 3.**
- IRN / e-invoicing (nullable columns reserved on `invoices`).
- COD doorstep-collection reconciliation (`awb_cod_synced_at` dormant).
- GSTR-1 export, RTO risk score, WhatsApp messaging (Phase 3/4 consumers of
  the domain events).
- Multi-currency, multi-location checkout (default location only).
- `shipping_zones` table (store_settings policy instead — §0 D13).
- Buyer-initiated cancellation from the storefront (console cancel only).
- Outbox repair sweep for domain events (jobId dedupe pre-wires it — §0 D11;
  a crash between commit and enqueue loses a notification, never a fact —
  record as known limitation in PROJECT_STATUS).
- A generic documents/transactions abstraction.

Sections:
0. Decisions table
1. Schema (DDL sketches + RLS classification + enums)
2. Migration plan
3. Module map (builder lots, disjoint ownership)
4. Flow sequences (transaction boundaries)
5. Order state machine + domain event catalog
6. Pure-function signatures + edge-case checklists
7. API routes + pages
8. Invoice rendering decision
9. Test matrix
10. Build schedule

---

# 0. Decisions

Every row was contested between the three designs or flagged by a judge.
D0 = correctness design, D1 = minimal-diff (winner/base), D2 = operator-ux.

| # | Contested | Chosen | Why |
| :-- | :-- | :-- | :-- |
| D1a | Checkout idempotency: `UNIQUE(tenant, cart_id)` (D1) vs brief §2.5 client-key recipe (D0) | **Both.** Client-supplied `idempotency_key` + partial unique index + stored `checkout_fingerprint` + 23505 replay + fingerprint mismatch → 422 `idempotency_key_reuse` is PRIMARY (the repo's established contract). `UNIQUE(tenant_id, cart_id) WHERE status = 'pending_payment'` stays as a belt | Judge 1 graft 2. The `WHERE status='pending_payment'` predicate fixes the judge-flagged brick bug: a hold-failure cancel drops the row out of the index, so the buyer's retry on the same cart is not replayed into a cancelled order |
| D2a | `stock_held` at confirm: D1 asserted "cannot fire" | **Handle BOTH `insufficient_stock` and `stock_held`** identically: TX-2 rolls back, TX-3 cancels the order + inserts the refund row + enqueues auto-refund, buyer-worded message | Trap-list violation in the winner (judge 1 graft 1). An expired checkout hold plus other active holds on the remainder makes `stock_held` reachable. Also discharges the PHASE2_FOLLOWUPS rewording contract |
| D3 | Place of supply: buyer-typed stateCode (D1) vs `pincode_directory` PLATFORM table (D0/D2) | **Static pincode-prefix → GST-state-code map in the pure serviceability barrel**, cross-checking the typed stateCode; mismatch → 422 `pincode_state_mismatch`. No new PLATFORM_TABLES entry, no seed data | Judge 1 graft 9's minimal form: never trust the buyer-typed state for the CGST/SGST-vs-IGST fork, without a 19k-row external dataset acquisition mid-build. Prefixes that legitimately span states map to a SET of allowed codes — refuse only when the typed state is outside the set |
| D4 | Gateway `createOrder`: worker job + buyer polling (D2, rule-literal) vs synchronous in the checkout request (D1/D0) | **Synchronous in the request — WRITTEN DEVIATION from the every-vendor-call-from-a-worker rule** | Judges 1 & 3 both kept it: the call is idempotent, single, fast, and buyer-blocking by nature; a worker round-trip costs ~1–2 s at the most conversion-sensitive moment and makes worker liveness a checkout dependency. Refunds (not buyer-blocking) DO run from the worker per the rule. This paragraph is the deviation record |
| D5 | COD: gated off (D1) vs confirms-at-placement (D2) | **Full COD confirms at placement through the SAME `confirmOrder` door**; invoice allocated inside that confirmation tx | Judge 3 graft 1 (highest-value): buyer-completable checkout with zero gateway involvement, and it exercises invoice-at-confirm without a webhook. The invoice-numbering rule reads "at payment confirmation, never at cart or order creation" — its rationale is that abandoned checkouts must never consume numbers; a COD confirmation has no abandonable pending window, so the rationale is preserved. Exposure note: a post-confirm cancel leaves an invoice without a credit note — same class as prepaid cancel-after-confirm, already a documented Phase 2 limitation (see NOT-built list) |
| D6 | Refund state: columns on the payment row (D1) vs `refunds` table (D0) | **`refunds` table with `UNIQUE (tenant_id, payment_id)`** — insert-once idempotency; `payments.purpose` enum dropped | Judge 1 graft 3: double-cancel and webhook-retry races become constraint-resolved, not status-guarded — the "unique constraint, not an app-side check" doctrine |
| D7 | Webhook secret: one sealed blob (D1) vs separate `sealed_webhook_secret` (D0/D2) | **Separate blob.** The webhook route unseals ONLY the HMAC secret, never the API keys | Judge 1 graft 6 / judge 3 graft 4: least-privilege at one column's cost |
| D8 | Coupon caps: slot-unique inserts (D1) vs `redeemed_count` + CHECK (D2) | **D1's slot mechanics kept** (unique constraint IS the enforcer, never a counter); checkout-start advisory count now runs under `SELECT promotions FOR UPDATE` | D2's counter breaches the brief. The FOR UPDATE at checkout-start (from D0) closes judge 2's flagged race where concurrent checkout-starts at cap−1 all pass; pending claims are counted read-side-expiring like holds |
| D9 | `abandoned → confirmed` revival (D0/D2) vs terminal `abandoned` (D1) | **Terminal.** A late `payment.captured` on an abandoned order records the money on the payment row and inserts a `refunds` row (auto-refund); no revival transition | Keeps the blueprint state diagram intact (judge 1 called revival a spec deviation and did not graft it). Money is never stranded; the refunds UNIQUE makes the path replay-safe. The abandon sweep's +5 min grace + order `FOR UPDATE` makes this path rare (an in-flight webhook wins) |
| D10 | Expiry: delayed job only (D1, judge-flagged: lost enqueue strands the order) vs scheduled sweep (D0/D2) | **Both**: per-order delayed job (precision) + a `sweep-checkouts` scheduled maintenance job every 10 min as backstop, `FOR UPDATE SKIP LOCKED`, grace = `expires_at + 5 min` | Judge 2 defect fix + judge 3 graft 5 + judge 2 graft 4 (SKIP LOCKED so the sweep never queues behind an in-flight confirm) |
| D11 | Domain-event delivery: fire-and-forget (D1) vs outbox + repair sweep (D0) | **Enqueue with `jobId = order_events.id`** (Redis-deduped); repair sweep deferred | Judge 1 graft 4: costs nothing now, makes a Phase 4 at-least-once sweep a pure additive. The gap (crash between commit and enqueue loses a notification) is recorded in PROJECT_STATUS as a known limitation |
| D12 | Ladder depth: dead-end at `ready_to_ship` (D1) vs manual staff buttons through `delivered` (D2) | **Manual staff transitions through the full forward ladder** (`shipped`, `out_for_delivery`, `delivered`); console renders ONLY the legal next transitions from `ORDER_TRANSITIONS` | Judge 3 graft 2 + judge 1 graft 8: merchants fulfil by hand until Phase 3 logistics; the machine is exercised and evented from day one; the transition table is already client-safe pure data so guardrail-as-UX is free. RTO/return edges stay in the table but unreachable (no button, no writer) |
| D13 | Serviceability: `shipping_zones` table (D2, judge 2 wanted it for D0) vs store_settings policy (D1) | **store_settings policy** (`shipping.pincode_policy`: all \| carrier \| list-of-prefixes; flat fee + free-above keys) | Neither judge grafting into the winner asked for zones; minimal-diff holds. Zones are a clean Phase 3 additive when carriers land |
| D14 | Customers console surface: none (D1, judge-flagged) vs full list with projections (D2) | **Minimal read-only `/customers` list** (name, phone, first_order_at, order count via aggregate query — no projection columns) | Fixes judge 3's defect without D2's `orders_count`/`total_spent` counter projections |
| D15 | Webhook-event processing mark: none + 5xx-retry (D1) vs `processed_at` column UPDATE (D2) | **None.** `payment_webhook_events` stays strictly append-only by grant; TX-1 evidence row commits first; processing failure → 5xx → gateway redelivery; idempotence lives in the payment/order state machine | D2's column-scoped UPDATE carve-out breaches the SELECT+INSERT grant doctrine and needs rls.ts machinery that doesn't exist. Judge 2 endorsed D1's split as correct |
| D16 | Order totals CHECK ambiguity (judge 2 flagged D0's) | **Pinned semantics**: `subtotal_paise` sums ITEM lines only (excludes the shipping line); CHECK `total_paise = subtotal_paise - discount_paise + shipping_paise`; `tax_paise` is informational (lines are truth) | Removes the double-counting ambiguity while keeping the belt |
| D17 | Settlement economics | **Capture `fee_paise` / `fee_tax_paise` from the webhook payload onto the payments row**; order detail renders gross − fee − fee GST = net | Judge 1 graft 7 / judge 2 graft 6: blueprint §5.2 asks for it; the data is free at the webhook writer |
| D18 | GST odd-paise intra-state split: independent rounding (D0) vs sum-invariant (D1) | **Sum-invariant**: `cgst = HALF_UP(tax/2)`, `sgst = tax − cgst` | Judge 2 graft 2: guarantees `cgst + sgst == tax`, eliminating the 1-paise B2B reconciliation dispute |
| D19 | Payments-settings ergonomics | **Copyable webhook URL, secrets never re-displayed (fingerprint after save), "send test event" button** backed by the mock driver POSTing a correctly-HMAC'd webhook to the real route | Judge 3 graft 3 — doubles as the manual verification tool |
| D20 | GST test pins | **Exact-integer pinned vectors** (§9): ₹999 inclusive @18% = **15,239 paise** tax; a crafted 3-line per-line-vs-sum 1-paise divergence case; FY boundary 2026-03-31T19:00:00Z (= Apr 1 00:30 IST) → `'2026-27'` | Judge 1 graft 5 / judge 3 graft 6 — named integers make tax tests audit-grade |
| D21 | Transition lost-update guard | `UPDATE orders SET status … WHERE status = <from>`; 0 rows → 409 `concurrent_modification`, on top of FOR UPDATE | Already in D1; judge 2 graft 3 endorses — kept explicit so no builder "simplifies" it away |

---

# 1. Schema

Three new schema files in `packages/db/src/schema/`: `commerce.ts`
(customers, carts, cart_lines, order_counters, orders, order_lines,
order_events), `payments.ts` (payment_accounts, payments,
payment_webhook_events, refunds, invoice_series, invoices), `promotions.ts`
(promotions, coupon_redemptions). **15 new tables, every one tenant-scoped
(DATA PLANE)**: `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE
CASCADE`, FORCE RLS automatic via `rls.ts`. **PLATFORM_TABLES unchanged.**
All ids UUIDv7 (`$defaultFn(uuidv7)`); all money `bigint` paise + `currency
CHAR(3) DEFAULT 'INR'`; all timestamps `timestamptz`. Enums are TEXT +
`$type<>` union + CHECK via `sqlLiteralList` (never a PG enum; never bind
parameters in DDL).

### FK-vs-bare-uuid ruling (history-table precedent)

| Table | Kind | Refs |
| :-- | :-- | :-- |
| customers, carts, cart_lines | live state | real CASCADE FKs |
| orders, payments, refunds, payment_accounts, promotions | long-lived records | tenant FK CASCADE; cross-refs **bare uuid** (snapshots carry meaning) |
| order_lines | snapshot, dies with order | `order_id` CASCADE FK; `variant_id` bare uuid nullable |
| order_events, payment_webhook_events, invoices, coupon_redemptions | append-only history | bare uuid, no FK to subjects; **append-only by grant** (`rls.ts::grantStatements` appendOnly set) |
| invoice_series, order_counters | counters | tenant FK CASCADE; written ONLY inside the confirming/creating tx |

## 1.1 customers

Guest-only was rejected for two Phase 2 needs requiring a stable buyer key:
per-customer coupon limits and the `first_order` condition.

```sql
CREATE TABLE customers (
  id             UUID PK uuidv7,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_e164     TEXT NOT NULL,            -- checkout identity key (E.164 CHECK, same regex as users)
  email          TEXT, name TEXT,          -- last seen; informational
  first_order_at TIMESTAMPTZ,              -- set once inside the first confirm tx
  created_at / updated_at TIMESTAMPTZ NOT NULL,
  deleted_at     TIMESTAMPTZ               -- blueprint soft-delete on customer tables
);
UNIQUE INDEX customers_tenant_phone_key (tenant_id, phone_e164);
```

No address table (no login → no address book). Delivery address is a JSONB
snapshot on the order.

## 1.2 carts + cart_lines

Cart identity = the cart row's UUIDv7 id in an httpOnly cookie scoped to the
storefront host (non-enumerable; a cookie replayed against another tenant's
host matches zero rows via RLS).

```sql
CREATE TABLE carts (
  id            UUID PK uuidv7,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'active',   -- CHECK in CART_STATUSES
  currency      CHAR(3) NOT NULL DEFAULT 'INR',
  buyer_name / buyer_phone_e164 / buyer_email TEXT,   -- checkout-in-progress scratch
  shipping_address JSONB,                  -- {line1,line2?,city,state_code,pincode}
  coupon_code   TEXT,                      -- uppercased; always re-evaluated server-side
  created_at / updated_at TIMESTAMPTZ NOT NULL
);
INDEX carts_tenant_updated_idx (tenant_id, updated_at);   -- 30-day GC sweep

CREATE TABLE cart_lines (
  id          UUID PK uuidv7,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cart_id     UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id  UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity    INT NOT NULL CHECK (quantity > 0 AND quantity <= 100),
  created_at / updated_at TIMESTAMPTZ NOT NULL
);
UNIQUE INDEX cart_lines_cart_variant_key (tenant_id, cart_id, variant_id);
```

No price on cart_lines (carts price live; snapshot happens at order
creation). No reservation columns anywhere — holds are `stock_reservations`
rows keyed `{type:'checkout', id: order_id}`, existing machinery untouched.

## 1.3 order_counters

Order numbers are merchant-facing labels (gaps fine), allocated by the same
UPDATE..RETURNING recipe because it is free and race-proof. Deliberately NOT
merged with invoice_series (different guarantees: order numbers allocate at
checkout-start where invoice numbers must never).

```sql
CREATE TABLE order_counters (
  tenant_id   UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  next_number BIGINT NOT NULL DEFAULT 1001
);
```

## 1.4 orders + order_lines

```sql
CREATE TABLE orders (
  id                 UUID PK uuidv7,
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_number       BIGINT NOT NULL,
  channel            TEXT NOT NULL DEFAULT 'web',   -- CHECK in ORDER_CHANNELS
  status             TEXT NOT NULL DEFAULT 'pending_payment',   -- CHECK in ORDER_STATUSES
  payment_status     TEXT NOT NULL DEFAULT 'pending',           -- CHECK in ORDER_PAYMENT_STATUSES
  fulfilment_status  TEXT NOT NULL DEFAULT 'unfulfilled',       -- CHECK; Phase 3 writes it

  cart_id            UUID,          -- bare uuid; idempotency belt anchor
  customer_id        UUID,          -- bare uuid → customers
  idempotency_key    TEXT,          -- client-supplied (brief §2.5)
  checkout_fingerprint TEXT,        -- sha256 of the canonical checkout request (D1a replay guard)

  buyer_name TEXT NOT NULL, buyer_phone_e164 TEXT NOT NULL, buyer_email TEXT,
  shipping_address   JSONB NOT NULL,
  place_of_supply    TEXT NOT NULL,   -- GST state code, cross-checked vs pincode prefix (D3)
  buyer_gstin        TEXT,

  currency           CHAR(3) NOT NULL DEFAULT 'INR',
  payment_mode       TEXT NOT NULL,    -- CHECK in CHECKOUT_PAYMENT_MODES: prepaid|cod|cod_advance
  subtotal_paise     BIGINT NOT NULL,  -- ITEM lines only, pre-discount, tax-inclusive (D16)
  discount_paise     BIGINT NOT NULL DEFAULT 0,
  shipping_paise     BIGINT NOT NULL DEFAULT 0,   -- the shipping LINE's gross
  tax_paise          BIGINT NOT NULL DEFAULT 0,   -- informational sum of line tax
  total_paise        BIGINT NOT NULL,
  amount_paid_paise  BIGINT NOT NULL DEFAULT 0,
  cod_due_paise      BIGINT NOT NULL DEFAULT 0,
  awb_cod_synced_at  TIMESTAMPTZ,       -- Phase 3 writes; modeled now (blueprint §4.3)

  promotion_id       UUID,              -- bare uuid; NULL when no coupon
  coupon_code_snapshot TEXT,

  payment_provider   TEXT,              -- CHECK in PAYMENT_PROVIDER_CODES; set at payment-start
  gateway_order_ref  TEXT,              -- gateway order id (order_xxx)

  placed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at / cancelled_at TIMESTAMPTZ,
  cancel_reason      TEXT,
  expires_at         TIMESTAMPTZ,       -- pending_payment TTL; read-side filter like holds
  created_at / updated_at TIMESTAMPTZ NOT NULL,

  CHECK (total_paise = subtotal_paise - discount_paise + shipping_paise),  -- D16 pinned semantics
  CHECK (amount_paid_paise >= 0),
  CHECK (cod_due_paise >= 0)
);
UNIQUE INDEX orders_tenant_number_key (tenant_id, order_number);
UNIQUE INDEX orders_idem_key (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;   -- PRIMARY idempotency (D1a)
UNIQUE INDEX orders_tenant_cart_pending_key (tenant_id, cart_id)
  WHERE cart_id IS NOT NULL AND status = 'pending_payment';               -- belt; excludes cancelled (D1a)
UNIQUE INDEX orders_gateway_ref_key (tenant_id, gateway_order_ref) WHERE gateway_order_ref IS NOT NULL;
INDEX orders_tenant_status_idx (tenant_id, status, placed_at);
INDEX orders_expiry_idx (tenant_id, status, expires_at);                  -- sweep + pending-claim counting
INDEX orders_customer_idx (tenant_id, customer_id);

CREATE TABLE order_lines (
  id               UUID PK uuidv7,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'item',   -- CHECK in ORDER_LINE_KINDS: item|shipping
  variant_id       UUID,                           -- bare uuid, nullable; snapshot is authoritative
  title_snapshot   TEXT NOT NULL,
  sku_snapshot     TEXT NOT NULL DEFAULT '',       -- '' for the shipping line
  hsn_snapshot     TEXT,
  quantity         INT NOT NULL CHECK (quantity > 0),
  unit_price_paise BIGINT NOT NULL,                -- as displayed (tax-inclusive default)
  discount_paise   BIGINT NOT NULL DEFAULT 0,      -- this line's allocated share, pre-tax
  taxable_paise    BIGINT NOT NULL,                -- post-discount, tax-EXCLUSIVE base
  tax_rate_bps     INT NOT NULL,
  cgst_paise / sgst_paise / igst_paise BIGINT NOT NULL DEFAULT 0,   -- stored split, never recomputed
  tax_paise        BIGINT NOT NULL,                -- = cgst+sgst+igst (sum-invariant split, D18)
  total_paise      BIGINT NOT NULL,
  position         INT NOT NULL DEFAULT 0
);
INDEX order_lines_order_idx (tenant_id, order_id);
```

## 1.5 order_events — append-only timeline + event source

```sql
CREATE TABLE order_events (
  id            UUID PK uuidv7,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id      UUID NOT NULL,               -- bare uuid, no FK
  event         TEXT NOT NULL,               -- §5.2 catalog
  from_status / to_status TEXT,              -- NULL for non-transition events
  actor_type    TEXT NOT NULL,               -- reuses ACTOR_TYPES: staff|customer|system
  actor_user_id UUID REFERENCES users(id),   -- users is control-plane; FK fine (audit_log precedent)
  data          JSONB,
  request_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INDEX order_events_order_idx (tenant_id, order_id, created_at);
```

In the `appendOnly` grant set. Merchant-visible timeline AND the source row
for queue emission: the BullMQ job is enqueued after commit with
`jobId = order_events.id` (D11).

## 1.6 payment_accounts, payments, payment_webhook_events, refunds

```sql
CREATE TABLE payment_accounts (       -- mirrors carrier_accounts
  id                UUID PK uuidv7,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_code     TEXT NOT NULL,    -- CHECK in PAYMENT_PROVIDER_CODES: razorpay|mock
  label             TEXT NOT NULL DEFAULT 'Default',
  public_key_id     TEXT NOT NULL,    -- razorpay key_id (public by design; browser checkout needs it)
  sealed_credentials TEXT NOT NULL,   -- envelope: {key_secret}; AAD = (tenant_id, provider_code)
  sealed_webhook_secret TEXT NOT NULL,-- SEPARATE envelope blob (D7); webhook route unseals only this
  credential_fingerprint TEXT NOT NULL,
  is_enabled        BOOLEAN NOT NULL DEFAULT false,
  last_verified_at  TIMESTAMPTZ, last_error TEXT,
  created_at / updated_at TIMESTAMPTZ NOT NULL, updated_by_user_id UUID REFERENCES users(id)
);
UNIQUE INDEX payment_accounts_tenant_provider_label_key (tenant_id, provider_code, label);
UNIQUE INDEX payment_accounts_one_enabled_key (tenant_id) WHERE is_enabled;   -- one live gateway in Phase 2

CREATE TABLE payments (               -- one row per gateway SALE attempt; mutable status
  id                 UUID PK uuidv7,
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id           UUID NOT NULL,   -- bare uuid (financial record outlives all but the tenant)
  payment_account_id UUID NOT NULL,   -- bare uuid (account may be rotated/deleted)
  provider_code      TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'created',  -- CHECK in PAYMENT_STATUSES: created|authorized|captured|failed
  amount_paise       BIGINT NOT NULL, currency CHAR(3) NOT NULL DEFAULT 'INR',
  gateway_order_id   TEXT,            -- order_xxx
  gateway_payment_id TEXT,            -- pay_xxx (set by webhook)
  method             TEXT,            -- upi|card|netbanking… as reported
  fee_paise          BIGINT,          -- gateway fee from webhook payload (D17)
  fee_tax_paise      BIGINT,          -- GST on the fee
  error_code / error_description TEXT,
  captured_at        TIMESTAMPTZ,
  created_at / updated_at TIMESTAMPTZ NOT NULL
);
UNIQUE INDEX payments_gateway_payment_key (tenant_id, gateway_payment_id) WHERE gateway_payment_id IS NOT NULL;
INDEX payments_order_idx (tenant_id, order_id);

CREATE TABLE payment_webhook_events ( -- append-only raw log; THE dedupe gate
  id               UUID PK uuidv7,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_code    TEXT NOT NULL,
  gateway_event_id TEXT NOT NULL,     -- x-razorpay-event-id; mock supplies its own
  event_type       TEXT NOT NULL,
  order_id / payment_id UUID,         -- bare uuids, resolved at receipt, nullable
  raw_payload      JSONB NOT NULL,    -- stored ONLY after HMAC verification
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
UNIQUE INDEX pwe_gateway_event_key (tenant_id, provider_code, gateway_event_id);
```

`payment_webhook_events` is append-only by grant — **no processed flag**
(D15): the row commits in its own small TX (evidence + dedupe); processing
runs as a second idempotent TX; 2xx only after the processing TX commits; a
processing failure returns 5xx and rides gateway redelivery.

```sql
CREATE TABLE refunds (                -- insert-once refund intents (D6)
  id                UUID PK uuidv7,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id          UUID NOT NULL,    -- bare uuid
  payment_id        UUID NOT NULL,    -- bare uuid → payments
  amount_paise      BIGINT NOT NULL CHECK (amount_paise > 0),   -- Phase 2: always the full capture
  status            TEXT NOT NULL DEFAULT 'pending',  -- CHECK in REFUND_STATUSES: pending|processing|processed|failed
  reason            TEXT NOT NULL,    -- 'merchant_cancelled'|'stock_shortfall'|'late_capture_abandoned'
  gateway_refund_id TEXT,
  created_at / updated_at TIMESTAMPTZ NOT NULL, created_by_user_id UUID REFERENCES users(id)
);
UNIQUE INDEX refunds_payment_key (tenant_id, payment_id);   -- at most ONE refund per capture; races → 23505 → replay
```

## 1.7 invoice_series + invoices

```sql
CREATE TABLE invoice_series (         -- blueprint 367–393 verbatim + hygiene
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  series_code    TEXT NOT NULL,       -- 'INV' (tax invoice) | 'BOS' (bill of supply)
  financial_year TEXT NOT NULL,       -- '2026-27', Indian FY, Asia/Kolkata boundary
  prefix         TEXT NOT NULL,
  next_number    INT  NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, series_code, financial_year)
);
-- rows created lazily inside the confirming tx:
-- INSERT .. ON CONFLICT DO NOTHING, then UPDATE .. RETURNING next_number - 1

CREATE TABLE invoices (               -- append-only; an issued document never mutates
  id             UUID PK uuidv7,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id       UUID NOT NULL,       -- bare uuid
  doc_type       TEXT NOT NULL,       -- CHECK in INVOICE_DOC_TYPES: tax_invoice|bill_of_supply
  series_code / financial_year TEXT NOT NULL,
  number         INT NOT NULL,
  invoice_number TEXT NOT NULL,       -- rendered '{prefix}/{FY}/{padded number}', frozen at issue
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  seller         JSONB NOT NULL,      -- {legal_name, gstin, address, state_code, tax_registration_type}
  buyer          JSONB NOT NULL,      -- {name, phone, email?, gstin?, shipping_address}
  place_of_supply TEXT NOT NULL,
  lines          JSONB NOT NULL,      -- full order_lines snapshot incl. tax split — THE render document
  subtotal_paise / discount_paise / taxable_paise /
  cgst_paise / sgst_paise / igst_paise / total_paise BIGINT NOT NULL,
  currency       CHAR(3) NOT NULL DEFAULT 'INR',
  irn TEXT, irn_qr TEXT, irn_registered_at TIMESTAMPTZ   -- Phase 3 e-invoicing room; no writer now
);
UNIQUE INDEX invoices_series_number_key (tenant_id, series_code, financial_year, number);   -- belt vs counter bugs
UNIQUE INDEX invoices_order_doc_key (tenant_id, order_id, doc_type);                        -- one invoice per order
```

Fully self-contained JSONB means rendering needs one row, zero joins — the
snapshot rule taken to its conclusion. IRN columns stay unwritten in Phase 2
(a narrow UPDATE grant is added in Phase 3, not now — table stays strictly
SELECT+INSERT).

## 1.8 promotions + coupon_redemptions

```sql
CREATE TABLE promotions (
  id            UUID PK uuidv7,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,        -- uppercased at write
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',   -- CHECK in PROMOTION_STATUSES
  starts_at / ends_at TIMESTAMPTZ,    -- NULL = unbounded
  conditions    JSONB NOT NULL DEFAULT '[]',     -- Condition[] (blueprint §4.4, zod-validated at write)
  effects       JSONB NOT NULL DEFAULT '[]',     -- Effect[]
  usage_limit_total INT, usage_limit_per_customer INT,   -- NULL = unlimited
  created_at / updated_at TIMESTAMPTZ NOT NULL, updated_by_user_id UUID REFERENCES users(id)
);
UNIQUE INDEX promotions_tenant_code_key (tenant_id, code);

CREATE TABLE coupon_redemptions (     -- append-only; THE limit enforcer (never a counter)
  id            UUID PK uuidv7,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  promotion_id  UUID NOT NULL,        -- bare uuid
  order_id      UUID NOT NULL,        -- bare uuid
  customer_id   UUID,                 -- bare uuid
  slot          INT NOT NULL,         -- 0-based position in the total-limit window
  customer_slot INT NOT NULL DEFAULT 0,
  discount_paise BIGINT NOT NULL,
  redeemed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
UNIQUE INDEX cr_promo_slot_key (tenant_id, promotion_id, slot);
UNIQUE INDEX cr_promo_customer_slot_key (tenant_id, promotion_id, customer_id, customer_slot)
  WHERE customer_id IS NOT NULL;
UNIQUE INDEX cr_promo_order_key (tenant_id, promotion_id, order_id);   -- one redemption per order; replay-safe
```

**Slot mechanics** (unique-constraint enforcement): inside the confirming tx,
`SELECT promotions FOR UPDATE` (serializes slot computation), `slot =
COUNT(*)` for the promotion, `customer_slot = COUNT(*)` for (promotion,
customer); refuse `coupon_exhausted` (422) when at limit; INSERT. A racer
that slips past collides on the unique index → 23505 → 409 retry. At
checkout-start the SAME `FOR UPDATE` serializes the advisory check (D8),
which counts redemption rows PLUS pending claims: `pending_payment` orders
carrying this `promotion_id` with `expires_at > now()` (read-side expiry,
exactly like holds).

## 1.9 Enum additions (`packages/db/src/schema/enums.ts`)

```ts
export const ORDER_STATUSES = ["pending_payment","confirmed","processing",
  "ready_to_ship","shipped","out_for_delivery","delivered","rto_initiated",
  "rto_delivered","return_requested","return_picked","refunded","cancelled",
  "abandoned"] as const;   // FULL blueprint set now; the transition table gates usage
export const ORDER_PAYMENT_STATUSES = ["pending","partially_paid","paid","refund_initiated","refunded"] as const;
export const ORDER_FULFILMENT_STATUSES = ["unfulfilled","partially_shipped","shipped","delivered","rto"] as const;
export const ORDER_CHANNELS = ["web","pos","whatsapp","manual"] as const;
export const CHECKOUT_PAYMENT_MODES = ["prepaid","cod","cod_advance"] as const;   // D5
export const CART_STATUSES = ["active","converted"] as const;
export const PAYMENT_PROVIDER_CODES = ["razorpay","mock"] as const;
export const PAYMENT_STATUSES = ["created","authorized","captured","failed"] as const;
export const REFUND_STATUSES = ["pending","processing","processed","failed"] as const;   // D6
export const INVOICE_DOC_TYPES = ["tax_invoice","bill_of_supply"] as const;
export const PROMOTION_STATUSES = ["draft","active","archived"] as const;
export const ORDER_LINE_KINDS = ["item","shipping"] as const;
// EXTENDED (migration re-creates the CHECK via sqlLiteralList):
export const STOCK_MOVEMENT_REASONS = ["opening_balance","adjustment","sale",
  "cancellation_restock"] as const;   // +1 member; RTO reasons arrive Phase 3 (followups doc)
```

## 1.10 Serviceability + policy config — NO new tables (D3, D13)

- **Pincode → state cross-check**: `PINCODE_PREFIX_STATES: Record<string,
  readonly string[]>` — a static 2-digit-prefix → allowed-GST-state-codes map
  shipped in the PURE `@platform/core/serviceability` barrel. Checkout
  refuses 422 `pincode_state_mismatch` when the typed stateCode is not in the
  prefix's allowed set. Prefixes spanning states list every legitimate code
  (safety over precision — never a false refusal).
- **Pincode serviceability policy**: `store_settings` key
  `shipping.pincode_policy`: `{"mode":"all"} | {"mode":"carrier"} |
  {"mode":"list","allowedPrefixes":[...]}` (default `all` — checkout works
  day one). `carrier` mode consults the existing `serviceability_cache` via
  the carrier registry, cache-first.
- **Shipping fee**: `store_settings` `shipping.flat_fee_paise`,
  `shipping.free_above_paise`.
- **Payment policy**: `store_settings` `payments.cod_enabled`,
  `payments.advance_bps`, `payments.min_advance_paise`.
- **Prefixes**: `store_settings` `orders.number_prefix`, `invoicing.prefix`
  (seeds new invoice_series rows).

## 1.11 rls.ts changes

`appendOnly` set gains: `order_events`, `payment_webhook_events`,
`invoices`, `coupon_redemptions`. `PLATFORM_TABLES` unchanged. Everything
else (FORCE RLS, policies, grants) is automatic from schema.

---

# 2. Migration plan

**One migration: `0008_*` (drizzle-generated name), single transaction.**
Current head is `0007_nasty_the_watchers.sql`; nothing here needs a split —
all 15 tables are new (no backfills, no data repair, no seed data), and the
only touch to an existing table is the `stock_movements` reason CHECK.

Ordering inside 0008 (drizzle emits it; verify on review):

1. CREATE the 15 tables + all indexes/CHECKs from §1. No
   `CREATE INDEX CONCURRENTLY` (single-transaction rule). CHECK lists via
   `sql.raw(sqlLiteralList(...))` — never bind parameters in DDL.
2. `stock_movements`: drop + re-create the reason CHECK to admit
   `cancellation_restock` (the enums.ts pattern; same shape as migration
   0007's `sale` addition).
3. No PLATFORM_TABLES change, no seed rows. `order_counters` and
   `invoice_series` rows are created lazily (INSERT .. ON CONFLICT DO
   NOTHING) inside the first allocating transaction — the
   `ensureDefaultLocation` get-or-create shape.

Coordinator-only steps (builders never run these): `pnpm db:generate` after
S0's schema files land → review SQL → `pnpm db:migrate` (re-applies RLS
idempotently; the generated RLS suite then auto-covers all 15 tables).
Rollback story: 0008 is purely additive except the CHECK swap; reverting =
dropping the new tables + restoring the previous CHECK (no data loss risk on
existing tables).

---

# 3. Module map

Every new domain gets the barrel split (pure `index.ts` client-safe, no
`@platform/db`; `server.ts` owns IO), both registered in
`packages/core/package.json#exports`. Extensionless relative imports.
Files are grouped into builder lots (§10) with **disjoint ownership** —
the lot tag `[S0|B1..B5|B-INT]` after each file is the owner; no file has
two owners.

**packages/db** (all [S0])
- `src/schema/commerce.ts` [NEW] — customers, carts, cart_lines, order_counters, orders, order_lines, order_events.
- `src/schema/payments.ts` [NEW] — payment_accounts, payments, payment_webhook_events, refunds, invoice_series, invoices.
- `src/schema/promotions.ts` [NEW] — promotions, coupon_redemptions.
- `src/schema/enums.ts` [EDIT] — §1.9 arrays; STOCK_MOVEMENT_REASONS +1.
- `src/schema/index.ts` [EDIT] — export the three new files.
- `src/rls.ts` [EDIT] — 4 additions to `appendOnly`; nothing else.

**packages/core**
- `src/tax/index.ts` [NEW] [B1] — PURE: GST engine, financialYearOf (IST), rounding, largest-remainder allocation.
- `src/invoices/index.ts` [NEW] [B1] — PURE: doc types, formatInvoiceNumber, docTypeFor, InvoiceDoc view model, amount-in-words helper (D19/§8).
- `src/invoices/server.ts` [NEW] [B1] — `allocateInvoiceNumber(tx, …)`, `createInvoice(tx, …)` (in-tx only; called only by checkout/server), `getInvoiceForRender`.
- `src/orders/index.ts` [NEW] [B5] — PURE: statuses, ORDER_TRANSITIONS, canTransition/assertTransition, event names/types, order-number formatting.
- `src/orders/server.ts` [NEW] [B5] — `transitionOrder(tx, ctx, order, to, event)` write door (WHERE status=from belt, D21), `enqueueOrderEvent`, console order queries, manual-transition + cancel entry points.
- `src/cart/index.ts` [NEW] [B4] — PURE: cart view types, line clamp constants.
- `src/cart/server.ts` [NEW] [B4] — get-or-create cart, upsertLine, removeLine, getCartView (live prices + availability).
- `src/checkout/index.ts` [NEW] [B-INT] — PURE: checkout payload types + zod schema, `computeCheckoutFingerprint` (sha256 over canonical request), pincode regex re-export.
- `src/checkout/server.ts` [NEW] [B-INT] — `startCheckout` (§4.2), `confirmFromWebhookEvent` (§4.4), `confirmCodOrder` (§4.3), `expireCheckout` (§4.6), `cancelOrder` orchestration (§4.7). **The ONLY module importing multiple `/server` barrels** (cart, orders, payments, promotions, invoices, customers, inventory).
- `src/payments/index.ts` [NEW] [B3] — PURE: provider codes, `PaymentGatewayAdapter` interface, `GatewayEvent`, `computeAdvanceSplit`.
- `src/payments/server.ts` [NEW] [B3] — payment_accounts CRUD (envelope seal/unseal — TWO blobs per D7 — fingerprint), `getEnabledAccount`, `unsealWebhookSecret` (webhook-route-only helper), `recordWebhookEvent` (TX-1), payment-row writes, `createRefundIntent(tx, …)` (insert-once via refunds UNIQUE).
- `src/promotions/index.ts` [NEW] [B2] — PURE: Condition/Effect types + zod, `evaluatePromotion`, `applyDiscountToLines`.
- `src/promotions/server.ts` [NEW] [B2] — promotions CRUD, `loadActivePromotionForUpdate(tx, code)`, `claimRedemption(tx, …)`, `countPendingClaims(tx, …)`.
- `src/serviceability/index.ts` [NEW] [B4] — PURE: pincode regex, `PINCODE_PREFIX_STATES` map, `statesForPincode(pincode)`, policy types.
- `src/serviceability/server.ts` [NEW] [B4] — `checkServiceability` (store_settings policy + serviceability_cache + carrier registry, cache-first).
- `src/customers/server.ts` [NEW] [B4] — `upsertCustomerByPhone(tx, …)`, `markFirstOrder(tx, …)`, `listCustomers` (aggregate order count, D14).
- `src/inventory/server.ts` [EDIT] [S0] — **extract-and-export** `consumeStockWithin(tx, ctx, input)` and `restockWithin(tx, ctx, lines, reference)` (thin wrappers over the existing internals); public API frozen — existing signatures/behavior unchanged; reword `StockHeldError.publicMessage` for the buyer path (PHASE2_FOLLOWUPS contract). Regression gate: the existing 238 integration tests pass untouched.
- `src/queues.ts` [EDIT] [S0] — `QUEUE_NAMES` += `orders: "orders"`, `payments: "payments"`.
- `src/identity/permissions.ts` [EDIT] [S0] — += `orders:read`, `orders:write`, `orders:cancel`, `promotions:read`, `promotions:write`, `payments:write`, `customers:read`; role grants.
- `package.json` [EDIT] [S0] — exports for all new barrels (registered up front with type-only stubs so parallel builders never touch this file).

**packages/integrations**
- `src/payments/types.ts` [NEW] [B3] — re-export of the core adapter contract (mirror of carriers).
- `src/payments/razorpay.ts` [NEW] [B3] — real driver: Orders API via fetch, HMAC-SHA256 verify (timingSafeEqual), webhook parse (incl. fee fields), refunds API.
- `src/payments/mock.ts` [NEW] [B3] — dev/CI driver + `mockWebhookBody(...)` fabricator/signer so tests drive the REAL webhook route. **Fail-closed gate: refuses when NODE_ENV is 'production' OR unset** (fake-carrier precedent).
- `src/payments/registry.ts` [NEW] [B3] — provider → adapter map with the gate.

**apps/storefront**
- `src/app/cart/page.tsx` [NEW] [B4] — cart page (force-dynamic, uncached live read).
- `src/app/checkout/page.tsx` [NEW] [B4] — address/contact/coupon/payment-mode form + gateway hand-off (client component; imports PURE barrels only).
- `src/app/order/[id]/page.tsx` [NEW] [B4] — guest order status page, gated by HMAC token `?t=` (constant-time compare); renders invoice via the shared component (§8).
- `src/app/api/cart/route.ts` [NEW] [B4] — GET view / POST upsert line.
- `src/app/api/cart/coupon/route.ts` [NEW] [B4] — POST/DELETE coupon code on cart.
- `src/app/api/checkout/serviceability/route.ts` [NEW] [B4] — POST pincode precheck.
- `src/app/api/checkout/route.ts` [NEW] [B-INT] — POST startCheckout.
- `src/app/api/payments/webhook/route.ts` [NEW] [B-INT] — the webhook door (§4.4).
- `src/lib/cart-cookie.ts` [NEW] [B4] — httpOnly cookie helper.
- `src/lib/order-token.ts` [NEW] [B4] — HMAC sign/verify for guest order URLs.

**apps/console**
- `src/app/(dashboard)/orders/page.tsx` + `orders/[id]/page.tsx` [NEW] [B5] — list (status filter, COD-due column) and detail: lines, payments **with net-settlement line (gross − fee − fee GST, D17)**, order_events timeline, **action buttons rendered ONLY from ORDER_TRANSITIONS' legal next states (D12)**, cancel dialog.
- `src/app/orders/[id]/invoice/page.tsx` [NEW] [B5] — print-CSS invoice (shared component, §8).
- `src/app/(dashboard)/customers/page.tsx` [NEW] [B4] — read-only customers list (D14).
- `src/app/(dashboard)/promotions/page.tsx` + `promotions/[id]/page.tsx` [NEW] [B2] — CRUD over conditions/effects.
- `src/app/(dashboard)/settings/payments/page.tsx` [NEW] [B3] — credential form (fingerprint-only display), **copyable webhook URL, send-test-event button (D19)**.
- `src/app/api/orders/route.ts`, `api/orders/[id]/route.ts`, `api/orders/[id]/transition/route.ts`, `api/orders/[id]/cancel/route.ts` [NEW] [B5].
- `src/app/api/customers/route.ts` [NEW] [B4].
- `src/app/api/promotions/route.ts` + `[id]/route.ts` [NEW] [B2].
- `src/app/api/settings/payments/route.ts` (+ `test-event/route.ts`) [NEW] [B3].
- nav component [EDIT] [B-INT] — +Orders, +Customers, +Promotions, +Payments-settings links.

**apps/worker**
- `src/jobs/order-events.ts` [NEW] [B-INT] — orders-queue Worker: `checkout.expire` delayed job + structured-log seam for all order.* events.
- `src/jobs/gateway-refund.ts` [NEW] [B-INT] — payments-queue Worker: adapter refund under backoff/circuit-breaker; marks refunds `processing`.
- `src/jobs/sweep-checkouts.ts` [NEW] [B-INT] — maintenance-scheduled backstop sweep (D10): `withPlatform` tenant list → `withTenant` each; FOR UPDATE SKIP LOCKED; grace `expires_at + 5 min`.
- `src/queues.ts` / `src/index.ts` [EDIT] [B-INT] — register queues/Workers; new imports BELOW `import "./env"`.

Lot-level trap callouts live in §10 with each lot's instructions.

---

# 4. Flows (transaction boundaries marked)

Every `[TX-x]` is one `withTenant(tenantId, tx => …)`. Everything outside a
TX marker is non-transactional (HTTP, cache purge, queue enqueue). Buyer
context is `{tenantId, requestId}` with tenant resolved from Host; staff
context is `WriteContext` from the session. Tenant id NEVER comes from a
payload.

## 4.1 Add to cart / update line (storefront)

1. Resolve tenant from Host; read `cart_id` cookie; zod-parse
   `{variantId, quantity}`.
2. `[TX]` get-or-create cart; **visibility SELECT** on variant (active, not
   deleted, product active); `getAvailability(tx, [variantId])` — refuse
   `insufficient_stock` (422) if requested > available for tracked variants;
   upsert cart_line (`ON CONFLICT (tenant_id, cart_id, variant_id) DO
   UPDATE`); touch `carts.updated_at`.
3. Set cookie if new. Return cart totals (priced live; coupon evaluated
   read-only if present). **No holds at cart stage.**

## 4.2 Checkout-start (storefront) — the holds boundary

`POST /api/checkout` with `{idempotencyKey, buyer, shippingAddress,
couponCode?, paymentMode: prepaid|cod|cod_advance}`.

1. Zod-parse; cheap validation (pincode `^[1-9][0-9]{5}$`, E.164 phone).
   **Pincode/state cross-check (D3)**: `statesForPincode(pincode)` from the
   pure map; typed `stateCode` not in the set → 422
   `pincode_state_mismatch`. Mode `cod`/`cod_advance` refused 422 when
   `payments.cod_enabled` is false; `cod_advance` refused when
   `payments.advance_bps` unset.
2. **Idempotency fast path (D1a)**: SELECT order by `(tenant_id,
   idempotency_key)`. Hit → compare `checkout_fingerprint` (sha256 over
   canonical: sorted cart lines (variantId, qty), pincode, stateCode,
   paymentMode, couponCode, buyer phone). Match → replay winner (same
   response shape). Mismatch → 422 `idempotency_key_reuse`.
3. Serviceability check (non-tx read): `checkServiceability(...)` → 422
   `pincode_unserviceable`.
4. `[TX-A]` — order creation:
   - Visibility SELECT all cart variants (the LAST live read; snapshot
     source).
   - Coupon: `loadActivePromotionForUpdate(tx, code)` — **`SELECT … FOR
     UPDATE`** (D8); re-evaluate conditions (pure); advisory cap check =
     redemption rows + pending claims (pending_payment orders with this
     promotion_id AND `expires_at > now()`) → 422 `coupon_exhausted`.
   - Pure pipeline: discount allocation → shipping line (fee from
     store_settings; taxed at the highest-value item line's rate) → GST per
     line (per-line HALF_UP then sum) → totals → `computeAdvanceSplit`.
   - `upsertCustomerByPhone(tx, …)`.
   - Allocate order_number: get-or-create `order_counters` row then
     `UPDATE .. RETURNING`.
   - INSERT `orders` (pending_payment, `expires_at = now() + 25 min`,
     idempotency_key + checkout_fingerprint set) + `order_lines` (full
     snapshot incl. shipping line + stored tax split) + `order_events`
     (`order.placed`, actor customer); mark cart `converted`.
   - Concurrent double-POST: 23505 on `orders_idem_key` → re-SELECT winner,
     fingerprint-check, replay (or 422 on mismatch).
5. `holdStock({tenantId}, {reference: {type:'checkout', id: orderId},
   lines})` — **its own `[TX-B]`, the existing entry point, unmodified**
   (15-min TTL, replace semantics). On `insufficient_stock`: `[TX-C]`
   transition order → `cancelled` (event `order.hold_failed`), return 422
   with per-line issues. The cancelled order leaves the
   `orders_tenant_cart_pending_key` partial index, so the buyer's retry on
   the same cart creates a fresh order (D1a). Crash between TX-A and TX-B
   leaves a pending order with no hold — harmless: confirmation consumes
   from ORDER lines (the on_hand CHECK is the real guard) and expiry reaps
   it.
6. Branch on mode:
   - **cod** → `confirmCodOrder` (§4.3), same request. Response
     `{orderId, orderToken, status: 'confirmed'}` — zero gateway
     involvement (D5).
   - **prepaid / cod_advance** → payment-start: unseal
     `payment_accounts.sealed_credentials`; adapter
     `createGatewayOrder(amount = total or advance)` — **the one synchronous
     outbound call (written deviation D4)**; `[TX-D]` INSERT `payments` row
     (`created`) + set `orders.gateway_order_ref`/`payment_provider`.
     Response `{orderId, orderToken, gatewayOrderId, publicKeyId,
     amountPaise}`.
   - **zero-total order** (100% discount): same as cod path with
     `cod_due = 0`, `payment_status = 'paid'` — confirms through the same
     door, no gateway.
7. After all commits: enqueue delayed `checkout.expire` job (orders queue,
   delay 30 min, `{tenantId, orderId}`, fail-soft — the sweep is the
   backstop, D10).

Payment retry: buyer re-POSTs with the same idempotencyKey → replay path
re-runs `holdStock` (replace semantics refresh the reference) and extends
`expires_at`.

## 4.3 COD confirm at placement (D5)

`confirmCodOrder(ctx, orderId)` — called only from startCheckout step 6:

`[TX-COD]` (the same code path as §4.4 TX-2 steps d–i, minus the payment
row): SELECT order FOR UPDATE → `consumeStockWithin(tx, …, ORDER lines)`
(**both failure codes handled**: failure → rollback → `[TX]` cancel order,
event `order.oversold` — no refund needed, no money moved) → transition
`pending_payment → confirmed` → `cod_due_paise = total`, `payment_status =
'pending'` → coupon claim (§1.8) → **invoice allocation + INSERT invoices
in this same tx** → `markFirstOrder` → order_events (`order.confirmed`,
actor customer) + audit. After commit: enqueue `order.confirmed`, purge
availability tags, respond.

## 4.4 Webhook confirm (storefront `/api/payments/webhook`) — the money tx

1. Resolve tenant from Host (each merchant registers
   `https://{their-domain}/api/payments/webhook` at the gateway — **no
   tenant id in any URL or payload**). Bounded raw-body read (256 KiB).
   `unsealWebhookSecret` for the enabled account (ONLY the webhook blob,
   D7); `verifyWebhook(rawBody, signature)` **before any domain work**;
   invalid → 401, nothing stored.
2. `[TX-1]` INSERT `payment_webhook_events` (raw payload, gateway event id)
   — 23505 on the event-id unique → **committed evidence already exists**:
   re-run processing idempotently (it no-ops on already-final state) and
   return 200. Fresh insert commits before processing (evidence survives a
   processing crash; retry rides gateway redelivery via 5xx — D15).
3. `[TX-2]` — the confirmation transaction, for `payment.captured`:
   - a. SELECT order by `gateway_order_ref` **FOR UPDATE**; SELECT payment
     row.
   - b. Idempotence gate: payment already `captured` → 200 replay.
   - c. **Amount check** vs expected (total or advance): mismatch → payment
     `failed` + event `payment.amount_mismatch`, no state advance,
     200 (merchant-visible flag).
   - d. Order no longer `pending_payment`?
     - `abandoned` (late capture, D9): record capture on the payment row +
       `amount_paid_paise`, `payment_status = 'refund_initiated'`, INSERT
       `refunds` row (reason `late_capture_abandoned` — insert-once via
       UNIQUE), event `payment.late_captured`; commit; enqueue refund job;
       200. Order STAYS abandoned.
     - `cancelled`/`confirmed`: replay/no-op guarded by (b) and the
       invoices UNIQUE — log event row only, 200.
   - e. payments → `captured` (+gateway_payment_id, method, **fee_paise /
     fee_tax_paise from the payload, D17**, captured_at);
     `orders.amount_paid_paise += amount`; `payment_status = paid |
     partially_paid` (cod_advance leaves `cod_due_paise` outstanding).
   - f. `transitionOrder(tx, …, 'confirmed')` — table-checked, `WHERE
     status = 'pending_payment'` belt (D21); sets confirmed_at, clears
     expires_at.
   - g. **`consumeStockWithin(tx, ctx, {reference: {type:'checkout', id:
     orderId}, lines: ORDER lines})`** — the order is the authority, never
     hold rows. **BOTH failure codes (`insufficient_stock` AND
     `stock_held`) take the same path (D2a)**: TX-2 rolls back entirely
     (invoice number returned, no redemption, no movements) → `[TX-3]`:
     re-INSERT nothing in webhook_events (already committed in TX-1); mark
     payment `captured` + order `amount_paid`, `payment_status =
     'refund_initiated'`; transition `pending_payment → cancelled`
     (cancel_reason `stock_shortfall`); INSERT `refunds` row (reason
     `stock_shortfall`, insert-once); events (`order.oversold`,
     `payment.refund_initiated`) with the buyer-worded message. After
     commit: enqueue auto-refund job. Money is never hostage to stock.
   - h. Coupon claim (if promotion_id): promotion FOR UPDATE, slot compute,
     INSERT redemption. Exhausted at this instant (window ≈ 0 given the
     serialized advisory): **confirm anyway, skip the insert, write
     `promotion.overredeemed` event** — never refuse captured money over a
     coupon.
   - i. **Invoice allocation, same tx**: get-or-create invoice_series row
     (`INV` regular / `BOS` unregistered+composition; FY =
     `financialYearOf(now, 'Asia/Kolkata')`); `UPDATE .. RETURNING
     next_number - 1`; INSERT `invoices` with the full JSONB snapshot.
   - j. `markFirstOrder`; order_events (`order.confirmed`, actor system);
     `recordAudit`.
4. After commit: enqueue `order.confirmed` (jobId = order_events.id);
   `purgeStorefrontCache(tenantId, availabilityTags)` fail-soft; respond
   200.

Other events: `refund.processed` → `[TX]` refunds row → `processed`
(+gateway_refund_id), order `payment_status = 'refunded'`, event
`order.refunded`. `payment.failed` → `[TX]` payment `failed`, event
`payment.failed`, order stays `pending_payment` (buyer may retry until
expiry).

## 4.5 Payment drivers (BYOG)

Adapter contract (types in `@platform/core/payments` pure barrel;
implementations in `@platform/integrations`):

```ts
interface PaymentGatewayAdapter {
  readonly provider: PaymentProviderCode;
  createGatewayOrder(creds, args: {amountPaise: number; currency: string; receipt: string}): Promise<{gatewayOrderId: string}>;
  verifyWebhook(webhookSecret: string, args: {rawBody: string; signature: string}): boolean;  // HMAC-SHA256, timingSafeEqual
  parseWebhook(rawBody: string): GatewayEvent;  // {eventId, type, gatewayOrderId, gatewayPaymentId?, amountPaise, method?, feePaise?, feeTaxPaise?, error?}
  refund(creds, args: {gatewayPaymentId: string; amountPaise: number; idempotencyKey: string}): Promise<{gatewayRefundId: string}>;
}
```

`razorpay.ts`: plain fetch + node:crypto; signature vs
`x-razorpay-signature`; event id from `x-razorpay-event-id`. `mock.ts`:
in-process synthetic ids + `mockWebhookBody()` fabricator/signer so dev/CI
drive the REAL webhook route; registry gate copies the fake-carrier
precedent — **refuses in production AND on unset NODE_ENV**.

## 4.6 Abandoned expiry (D10)

Two drivers, one door (`expireCheckout`):

- Delayed job `checkout.expire` (from §4.2.7).
- Scheduled `sweep-checkouts` (maintenance queue, `upsertJobScheduler` every
  10 min): `withPlatform` tenant list → per tenant `withTenant`, SELECT
  pending_payment orders with `expires_at < now() - 5 min` (grace) **FOR
  UPDATE SKIP LOCKED** (never queues behind an in-flight confirm).

Per order: `[TX]` still pending? (order FOR UPDATE — an in-flight webhook
wins) → `expires_at` extended by a retry → re-enqueue at new expiry; else
transition `pending_payment → abandoned` + event. Then
`releaseStock({tenantId}, {type:'checkout', id})` — own `[TX]`, existing
entry point, idempotent (holds already stopped counting read-side at
expires_at — the job is bookkeeping, never correctness). Enqueue
`order.abandoned`.

## 4.7 Cancel + full refund (pre-shipment; console)

`POST /api/orders/[id]/cancel` (permission `orders:cancel`):

1. `[TX]` SELECT order FOR UPDATE; transition table permits `confirmed →
   cancelled` and `processing → cancelled` only (anything at/after
   ready_to_ship → 422 `invalid_transition`). Restock tracked item lines
   via `restockWithin(tx, …)`: +qty movements, reason
   `cancellation_restock`, reference `{type:'order', id}` (same-tx ledger +
   projection). If `amount_paid_paise > 0`: INSERT `refunds` row
   (insert-once — a double-cancel race resolves on the UNIQUE, D6) +
   `payment_status = 'refund_initiated'`. cancelled_at, event
   (`order.cancelled`, actor staff), `recordAudit`.
2. After commit: enqueue `payments.refund` job `{tenantId, refundId}`; the
   worker unseals creds, calls adapter `refund(idempotencyKey = refundId)`
   under backoff/circuit-breaker, `[TX]` marks the refund `processing`;
   terminal `processed` arrives via the `refund.processed` webhook (§4.4).
   Enqueue `order.cancelled`; purge tags for restocked products.

## 4.8 Manual fulfilment ladder (D12)

`POST /api/orders/[id]/transition` `{to}` (permission `orders:write`),
Phase 2 legal manual moves: `confirmed→processing`,
`processing→ready_to_ship`, `ready_to_ship→shipped`,
`shipped→out_for_delivery`, `out_for_delivery→delivered`. One `[TX]`
through `transitionOrder` (FOR UPDATE + table check + WHERE-status belt +
event + audit). `delivered` on a COD order sets `payment_status = 'paid'`
and `amount_paid_paise = total` (doorstep collection assumed; reconciliation
is Phase 3). Console renders buttons ONLY from
`ORDER_TRANSITIONS[current]` ∩ the manual allowlist.

---

# 5. Order state machine + domain events

## 5.1 Transition table (pure data, `@platform/core/orders`)

The FULL blueprint state set ships in one migration; the transition table is
the gate keeping Phase-3 edges unreachable. Client-safe, exhaustively
unit-tested (14×14 matrix).

```ts
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment:  ["confirmed", "abandoned", "cancelled"], // cancelled = hold_failed / oversold
  confirmed:        ["processing", "cancelled"],
  processing:       ["ready_to_ship", "cancelled"],
  ready_to_ship:    ["shipped"],
  shipped:          ["out_for_delivery", "rto_initiated"],   // rto edges: Phase 3 writers
  out_for_delivery: ["delivered", "rto_initiated"],
  rto_initiated:    ["rto_delivered"],
  delivered:        ["return_requested"],
  return_requested: ["return_picked"],
  return_picked:    ["refunded"],
  abandoned: [], cancelled: [], refunded: [], rto_delivered: [],   // terminal (no revival — D9)
};
```

**Enforcement**: ONE write door, `transitionOrder(tx, ctx, order, to,
event)` in `@platform/core/orders/server`, called by confirm (webhook +
COD), cancel, expiry, and the console transition route. It (1) checks
`canTransition` → 422 `invalid_transition` with `{from, to, allowed}`
details; (2) `UPDATE orders SET status … WHERE status = <from>` — 0 rows →
409 `concurrent_modification` (D21); (3) INSERTs the order_events row;
(4) returns the event descriptor for post-commit enqueue. No route mutates
`orders.status` directly.

Phase 2 reachable: pending_payment, confirmed, processing, ready_to_ship,
shipped, out_for_delivery, delivered (manual, D12), cancelled, abandoned.
Console manual allowlist: `confirmed→processing`,
`processing→ready_to_ship`, `ready_to_ship→shipped`,
`shipped→out_for_delivery`, `out_for_delivery→delivered` (+ the cancel
route). RTO/return edges exist in the table, no writer.

## 5.2 Domain event catalog

Queues: `orders` (domain events + delayed expiry), `payments` (outbound
gateway work). Job name = event name; **jobId = order_events.id** (D11,
Redis-deduped). Payload (`TenantJob` discipline — tenantId mandatory,
handler's first act is `withTenant`):

```ts
type OrderDomainEvent = {
  tenantId: string; orderId: string;
  event: OrderEventName; occurredAt: string;  // ISO, from the order_events row
  orderEventId: string;                       // provenance + jobId
  requestId?: string | null;
  data?: Record<string, unknown>;             // small: amounts, order_number — consumers re-read DB for truth
};
```

| Event | Emitter (after which tx) | order_events row | Phase 2 consumer |
| :-- | :-- | :-- | :-- |
| `order.placed` | startCheckout TX-A | yes (from=null, to=pending_payment) | log seam (worker `order-events`) |
| `order.confirmed` | webhook TX-2 / COD TX-COD | yes (→confirmed) | log seam; Phase 4 messaging hook |
| `order.hold_failed` | startCheckout TX-C | yes (→cancelled) | log seam |
| `order.oversold` | webhook TX-3 / COD failure TX | yes (→cancelled) | log seam |
| `order.cancelled` | cancelOrder TX | yes (→cancelled) | log seam |
| `order.abandoned` | expireCheckout TX | yes (→abandoned) | log seam; Phase 4 abandoned-cart messaging hook |
| `order.refunded` | refund.processed webhook TX | yes (no status change) | log seam |
| `order.processing` / `order.ready_to_ship` / `order.shipped` / `order.out_for_delivery` / `order.delivered` | manual transition TX | yes (transition) | log seam |
| `payment.failed` | webhook TX | yes (no transition) | log seam |
| `payment.amount_mismatch` | webhook TX-2c | yes | log seam (merchant-visible timeline) |
| `payment.late_captured` | webhook TX-2d abandoned path | yes | log seam |
| `payment.refund_initiated` | cancel / TX-3 | yes | worker `gateway-refund` consumes the separate `payments.refund` job |
| `promotion.overredeemed` | webhook TX-2h | yes | log seam (merchant flag) |

Emission is always AFTER the writing tx commits, fail-soft. The
order_events table row is the durable record; the queue message is
delivery. Deferred: an outbox repair sweep (pure additive later thanks to
jobId dedupe — D11).

---

# 6. Pure-function signatures + edge cases

All in pure barrels: no DB, no env, no hidden Date.now() (clock passed in).
100% branch coverage expected on tax and promotions (discount/tax bugs cost
money).

## 6.1 GST engine (`@platform/core/tax`)

```ts
type TaxableLine = {
  lineId: string;
  taxablePaise: number;   // post-discount; inclusive OR exclusive per ctx flag
  taxRateBps: number;     // 0 | 500 | 1200 | 1800 | 2800 …
};
type TaxContext = {
  sellerStateCode: string;          // tenants.origin_state_code
  placeOfSupplyStateCode: string;   // delivery address state (cross-checked, D3)
  registrationType: TaxRegistrationType;   // unregistered|regular|composition
  inclusive: boolean;               // default true (locked)
};
type LineTax = {
  lineId: string;
  taxableExclusivePaise: number;    // base after inclusive extraction
  cgstPaise: number; sgstPaise: number; igstPaise: number; taxPaise: number;
};

export function computeLineTaxes(lines: TaxableLine[], ctx: TaxContext): LineTax[];
export function financialYearOf(at: Date, tz?: "Asia/Kolkata"): string;   // '2026-27'
export function docTypeFor(reg: TaxRegistrationType): "tax_invoice" | "bill_of_supply";
export function roundHalfUp(numer: number, denom: number): number;        // integer-only HALF_UP
export function allocateProportionally(totalPaise: number, weights: number[]): number[];
  // largest-remainder; sum(out) === totalPaise EXACTLY; spreads order-level discount pre-tax
```

Rules encoded: unregistered/composition → all zeros (Bill of Supply, even
with buyer_gstin present); intra-state (seller === PoS) → **sum-invariant
odd-paise split (D18): cgst = HALF_UP(tax/2), sgst = tax − cgst**;
inter-state → IGST full; inclusive extraction `tax = gross × r / (10000 +
r)` **rounded HALF_UP per line then summed — never sum-then-round**;
exclusive `tax = base × r / 10000`.

Edge-case checklist (each a named unit test; pinned integers per D20):
- [ ] **₹999 inclusive @18% → tax = 15,239 paise** (99900×1800/11800 =
      15238.98… → HALF_UP 15239) — the classic, exact integer pinned.
- [ ] **3-line per-line-vs-sum divergence**: crafted case where
      Σ round(line) ≠ round(Σ line) by exactly 1 paise; assert per-line wins.
- [ ] **FY IST boundary: 2026-03-31T19:00:00Z (= Apr 1 00:30 IST) →
      '2026-27'**; 2026-03-31T18:00:00Z (= Mar 31 23:30 IST) → '2025-26'.
- [ ] odd-paise intra split: tax 15p → cgst 8 / sgst 7 (sum invariant);
      tax 1p → cgst 1 / sgst 0.
- [ ] rate 0 (exempt) → zero-tax line, still on the invoice.
- [ ] rounding exactly .5 → up (away from zero).
- [ ] quantity multiplied before extraction (line total is the base).
- [ ] discount to zero → taxable 0, tax 0 (never negative).
- [ ] shipping line at the highest-value item line's rate (principal-supply
      proxy, computed by the caller; **flag for a CA** — engineering
      simplification, not tax advice).
- [ ] state-code normalization (case/whitespace) before intra/inter compare.
- [ ] max-money lines: no float drift (all integer math).
- [ ] exclusive mode add-on.
- [ ] allocateProportionally: 100p over 3 equal lines → [34,33,33], sums
      exactly; zero-weight line gets 0.

## 6.2 Partial payment (`@platform/core/payments` pure)

```ts
type AdvancePolicy = {
  codEnabled: boolean;
  advanceBps: number | null;    // 2000 = 20%; null = partial mode unavailable
  minAdvancePaise: number;      // floor
};
export function computeAdvanceSplit(totalPaise: number, policy: AdvancePolicy,
  mode: "prepaid" | "cod" | "cod_advance"): { advancePaise: number; codDuePaise: number };
```

Edge-case checklist:
- [ ] cod disabled + mode cod/cod_advance → throw `invalid_payload` (422).
- [ ] cod_advance with advanceBps null → `advance_not_configured` (422).
- [ ] advance rounds HALF_UP from bps; clamped to [minAdvance, total].
- [ ] minAdvance > total → advance = total (codDue 0 — effectively prepaid).
- [ ] mode cod → advance 0, codDue = total.
- [ ] zero-total order → advance 0, codDue 0, gateway skipped (§4.2.6).
- [ ] invariant asserted: advance + codDue === total exactly.

## 6.3 Promotions (`@platform/core/promotions`)

```ts
type CartForEvaluation = {
  lines: { variantId: string; productId: string; categoryIds: string[];
           quantity: number; unitPricePaise: number }[];
  subtotalPaise: number; shippingPaise: number;
  channel: "web" | "pos" | "whatsapp" | "manual";
};
type CustomerForEvaluation = { id: string | null; isFirstOrder: boolean } | null;

export const conditionSchema: z.ZodType<Condition>;   // FULL blueprint §4.4 unions incl. customer_segment
export const effectSchema: z.ZodType<Effect>;         // incl. buy_x_get_y
export function evaluatePromotion(promo: PromotionData, cart: CartForEvaluation,
  customer: CustomerForEvaluation, now: Date):
  | { applicable: true; discount: AppliedDiscount }
  | { applicable: false; reason: PromotionRefusalReason };
  // reasons are API contract: not_started|expired|conditions_not_met|coupon_exhausted
  //   |requires_customer|unknown_condition|unsupported_condition
export function applyDiscountToLines(lines, discount: AppliedDiscount):
  { lineDiscountsPaise: number[]; shippingPaise: number };   // largest-remainder, pre-tax
```

Blueprint §4.4 vocabulary ships COMPLETE (`buy_x_get_y` and
`customer_segment` are typed and zod-accepted); `customer_segment` evaluates
to `{applicable:false, reason:'unsupported_condition'}` until segments exist
(Phase 4) — reserved-but-honest, never a silent pass.

Edge-case checklist (100% branch):
- [ ] each Condition type pass/fail; conditions AND-ed; empty = always
      applicable within window.
- [ ] unknown condition type in stored jsonb → `unknown_condition` refusal
      (forward-compat, never throw).
- [ ] percent_off with maxDiscountPaise cap hit / not hit / cap 0; bps 10000.
- [ ] flat_off > subtotal → clamp (never negative totals).
- [ ] free_shipping with shipping already 0 (zero-value, still applied).
- [ ] buy_x_get_y: qty x−1 / x / 2x (multiples); getVariantIds absent from
      cart → discount cheapest eligible present, else inapplicable.
- [ ] first_order: null customer at preview → "may apply"; server passes the
      upserted row's `first_order_at IS NULL`.
- [ ] window boundaries inclusive-start exclusive-end; not_started/expired.
- [ ] channel mismatch.
- [ ] allocation across lines sums exactly (invariant).
- [ ] zero-subtotal cart.
- [ ] ONE coupon per cart (no stacking — documented; types don't preclude).

## 6.4 Serviceability (`@platform/core/serviceability` pure part)

```ts
export const PINCODE_RE = /^[1-9][0-9]{5}$/;
export const PINCODE_PREFIX_STATES: Record<string, readonly string[]>;  // 2-digit prefix → allowed GST state codes
export function statesForPincode(pincode: string): readonly string[];   // [] = unknown prefix → do NOT refuse (log only)
```

Edge-case checklist: invalid shape refused before lookup; multi-state
prefixes return the full set; unknown prefix returns [] and the caller
accepts the typed state (fail-open on the CROSS-CHECK only — the
serviceability policy still applies); mismatch → 422
`pincode_state_mismatch` with the allowed states in details.

## 6.5 Checkout fingerprint (`@platform/core/checkout` pure)

```ts
export function computeCheckoutFingerprint(input: {
  lines: {variantId: string; quantity: number}[];  // sorted by variantId
  pincode: string; stateCode: string; paymentMode: string;
  couponCode: string | null; buyerPhone: string;
}): string;   // sha256 hex over the canonical JSON
```

Edge cases: line order does not affect the hash; couponCode
null-vs-absent-vs-'' canonicalized; case-normalized coupon and state.

---

# 7. API routes + pages

Envelope everywhere: `{ error: { code, message, details? }, requestId }`;
422 validation with `details.issues: [{path, message}]`;
`rejectMalformedId` on every path id. Console routes ride the
`handleCatalogWrite` pipeline (it is not catalog-specific — pass your own
permission). Storefront routes resolve tenant from Host, buyer context, no
session actor, bounded bodies. All storefront pages force-dynamic; live
commerce reads (cart, checkout availability) are NEVER `unstable_cache`d.

## Storefront (buyer, no auth)

| Route | Method | Zod payload | Notes |
| :-- | :-- | :-- | :-- |
| `/api/cart` | GET | — | cart view: live prices, availability, totals, coupon preview |
| `/api/cart` | POST | `{variantId: uuid, quantity: int 0..100}` | upsert; 0 = remove |
| `/api/cart/coupon` | POST/DELETE | `{code: string 1..40}` | stores uppercased code; evaluation read-only |
| `/api/checkout/serviceability` | POST | `{pincode: /^[1-9][0-9]{5}$/}` | precheck widget |
| `/api/checkout` | POST | `{idempotencyKey: string 8..64, buyerName: 1..120, phone: E164, email?, shippingAddress: {line1, line2?, city, stateCode: 2, pincode}, buyerGstin?: GSTIN regex, couponCode?, paymentMode: 'prepaid'\|'cod'\|'cod_advance'}` | §4.2; returns gateway hand-off or confirmed COD |
| `/api/payments/webhook` | POST | raw body + signature header (no zod — adapter parses) | HMAC before everything; 256 KiB bound; 2xx only after commit |
| `/cart`, `/checkout` | pages | — | force-dynamic, uncached |
| `/order/[id]?t=<hmac>` | page | — | guest status + invoice; constant-time token compare |

## Console (session + permission)

| Route | Method | Permission | Payload |
| :-- | :-- | :-- | :-- |
| `/api/orders` | GET | orders:read | query `status?, q?, limit, offset` |
| `/api/orders/[id]` | GET | orders:read | detail: lines, payments (+net settlement), refunds, events timeline, invoice ref |
| `/api/orders/[id]/transition` | POST | orders:write | `{to}` ∈ manual allowlist (§5.1) |
| `/api/orders/[id]/cancel` | POST | orders:cancel | `{reason?: string ≤500}` |
| `/api/customers` | GET | customers:read | query `q?, limit, offset` (D14) |
| `/api/promotions` (+`/[id]`) | GET/POST/PUT/DELETE | promotions:read/write | `{code: /^[A-Z0-9_-]{3,40}$/i, name, status, startsAt?, endsAt?, conditions: Condition[], effects: Effect[] min 1, usageLimitTotal?: int>0, usageLimitPerCustomer?: int>0}`; DELETE archives |
| `/api/settings/payments` | GET/PUT | payments:write | `{providerCode, publicKeyId, keySecret, webhookSecret, isEnabled}` — two sealed blobs on write (D7); GET returns fingerprint + webhook URL only, never secrets |
| `/api/settings/payments/test-event` | POST | payments:write | `{}` — mock driver POSTs a correctly-HMAC'd `payment.captured` test webhook to the tenant's storefront route (D19); mock-provider accounts only |
| Pages | | | `/orders`, `/orders/[id]`, `/orders/[id]/invoice`, `/customers`, `/promotions`, `/promotions/[id]`, `/settings/payments` |

---

# 8. Invoice rendering decision

**One approach: print-CSS HTML (server-rendered React), zero PDF
dependency.** A shared `<InvoiceDocument doc={…}/>` server component
(judge 2 graft 5) renders the `invoices` row — one SELECT, zero joins, the
JSONB snapshot IS the document — used by BOTH `console/orders/[id]/invoice`
and the guest `storefront/order/[id]` page. Contents: header "Tax Invoice" /
"Bill of Supply" by doc_type, seller/buyer blocks (GSTIN when present), line
table with HSN + per-line tax split, **per-rate tax summary table**,
**amount-in-words** (pure helper in `@platform/core/invoices`, unit-tested),
`@page` A4 rules + `page-break-inside: avoid`, visible "Print / Save as
PDF" button (`window.print()`), and a conditional IRN/QR block rendering
when `invoices.irn` is non-null (Phase 3 e-invoicing needs zero layout
rework).

Rejected: headless Chromium (~300 MB image + ~150 MB RSS per render on a
VPS that doesn't exist yet; the Phase 3 "email PDF" feature bolts a
worker-side renderer onto this SAME route); pdfkit/react-pdf (hand-placed
coordinates = a second layout engine, poor Indic shaping for merchant legal
names).

---

# 9. Test matrix

Unit = `packages/core/tests/*.test.ts` (no DB, no env). Integration =
`*.integration.test.ts` against the shared Docker Postgres (ports 5442/6442/
6389 — non-default on purpose), centrally serialized. Counts are targets;
builders report exact per-file counts for the PROJECT_STATUS verified block
(currently 325 unit / 238 integration; never delete or skip an existing
test). Setup discipline: own tenants/plans/users via the migrator client,
teardown tenants → users → plans, stock seeded through `recordMovement`,
purge endpoint stubbed on port 0, env restored before pool close, jsonb
fixtures bound `::text::jsonb`.

| Suite (file) | Kind | Pins | ~n |
| :-- | :-- | :-- | --: |
| `core/tests/tax.test.ts` | unit | every §6.1 box incl. the three D20 pinned vectors (₹999→15,239p; 3-line 1-paise divergence; FY 2026-03-31T19:00Z→'2026-27'), sum-invariant split, allocation exactness | 42 |
| `core/tests/promotions.test.ts` | unit | 100% branch per §6.3 incl. buy_x_get_y multiples, customer_segment `unsupported_condition`, refusal-reason contract | 46 |
| `core/tests/order-state-machine.test.ts` | unit | full 14×14 matrix table-driven, terminality (no abandoned revival), manual allowlist subset | 16 |
| `core/tests/partial-payment.test.ts` | unit | §6.2 boxes incl. cod mode, zero-total, exact-sum invariant | 12 |
| `core/tests/invoice-number.test.ts` | unit | formatInvoiceNumber padding/prefix, docTypeFor, amount-in-words | 10 |
| `core/tests/serviceability.test.ts` | unit | §6.4 boxes: prefix map, multi-state sets, unknown-prefix fail-open, mismatch detection | 8 |
| `core/tests/checkout-fingerprint.test.ts` | unit | §6.5 canonicalization | 6 |
| `core/tests/payments-adapters.test.ts` | unit | mock determinism, razorpay HMAC known-vector + tamper, parseWebhook shapes incl. fee fields, registry fail-closed on unset AND production NODE_ENV | 14 |
| `core/tests/checkout.integration.test.ts` | int | the spine: cart→checkout (order+snapshot+hold, order_number, cart converted) → mock webhook → confirmed (sale movements with order reference, invoice row + number, coupon slot, events); **idempotency-key replay + fingerprint-mismatch 422**; cart_id belt: hold-failure cancel then SAME-cart retry succeeds (D1a); double webhook (same event id) = one confirmation; **COD checkout confirms with zero gateway + invoice in the same tx (D5)**; zero-total order | 20 |
| `core/tests/checkout-concurrency.integration.test.ts` | int | two concurrent confirms → distinct consecutive invoice numbers; forced failure after allocation returns the number (gap-free proof); coupon slot race 23505→409; checkout-start advisory serialized at cap−1 (D8); **last-unit steal → oversold path: order cancelled, refund row inserted-once, NO invoice, NO redemption, zero sale movements; stock_held variant of the same (D2a)** | 11 |
| `core/tests/cancel-refund.integration.test.ts` | int | confirmed→cancelled restocks (`cancellation_restock` ledger + projection, reconcile clean); **double-cancel race → ONE refunds row (UNIQUE)**; refund job → processing; refund webhook → processed + order refunded; shipped-state cancel 422; **late capture on abandoned order → refund row, order stays abandoned (D9)** | 11 |
| `core/tests/promotions-server.integration.test.ts` | int | CRUD, per-customer slot, exhaustion at checkout-start, overredeemed-confirm-anyway flag path | 7 |
| `core/tests/payment-accounts.integration.test.ts` | int | seal/unseal roundtrip for BOTH blobs, webhook route unseals only the webhook blob (D7), AAD cross-tenant copy fails, fingerprint-only reads, one-enabled unique | 6 |
| `apps/storefront/tests/cart-checkout-routes.integration.test.ts` | int | cookie lifecycle, tenant-by-host isolation, zod 422 envelopes, serviceability + **pincode_state_mismatch**, webhook 401 bad HMAC / 200 dup replay, guest token gate, **fee fields land on the payment row (D17)** | 14 |
| `apps/console/tests/orders-routes.integration.test.ts` | int | list/detail authz, **manual ladder walk to delivered incl. COD paid-at-delivered (D12/§4.8)**, illegal transition 422, `orders:cancel` permission split, timeline reads, customers list (D14) | 11 |
| `apps/console/tests/promotions-routes.integration.test.ts` | int | CRUD + zod condition/effect refusals | 5 |
| `apps/console/tests/payment-settings-routes.integration.test.ts` | int | secrets never echoed, webhook URL in GET, **send-test-event drives the real storefront webhook route end to end (D19)** | 5 |
| `apps/worker/tests/order-jobs.integration.test.ts` | int | checkout.expire: releases + abandons, skips paid, re-enqueues extended expiry; **sweep backstop: grace period + SKIP LOCKED under a concurrent confirm (D10)**; refund job idempotency-key pass-through | 7 |
| RLS isolation | int | generated suite auto-covers the 15 new tables; explicit cross-tenant probes for webhook route + coupon slots | 4 |
| **Totals** | | **~154 unit / ~101 integration added** | |

Existing 238 integration tests — especially
`stock-reservations.integration.test.ts` — must pass untouched: that is the
regression gate on the S0 inventory refactor.

---

# 10. Build schedule

```
S0 (serial spine) ──► B1 ∥ B2 ∥ B3 ∥ B4 ∥ B5 (parallel, disjoint files) ──► B-INT (serial integrator)
```

Per-lot verification = `corepack pnpm --filter <pkg> typecheck` + repo-root
lint + the lot's UNIT tests only. **Integration runs are centrally
coordinated** (one shared Docker Postgres, serialized) — a builder NEVER
runs `pnpm test:integration`, `pnpm build`, or `db:migrate`. Every lot reads
CONVENTIONS_BRIEF.md + this spec §-refs in its task; the traps named below
are IMPERATIVE for that lot.

**S0 — Schema spine (serial, first).**
Owns: `packages/db/src/schema/{commerce,payments,promotions}.ts` + enums.ts
+ schema/index.ts + rls.ts appendOnly; `packages/core/package.json` exports
(all new barrels registered with type-only stubs, incl. frozen signatures
for `allocateInvoiceNumber`, `claimRedemption`, `transitionOrder`,
`consumeStockWithin` so B-lots code against stubs); `queues.ts`;
`identity/permissions.ts`; **the inventory extract-method refactor**
(`consumeStockWithin`/`restockWithin` + StockHeldError reword).
Traps: no PG enums — TEXT + CHECK via `sqlLiteralList`, never bind params in
DDL; history tables bare-uuid no-FK + appendOnly grant; live-state CASCADE
never RESTRICT; FORCE RLS is automatic — do NOT touch PLATFORM_TABLES;
inventory public API frozen (extract-method only); no `CREATE INDEX
CONCURRENTLY`.
Verify: typecheck all packages with stubs; unit tests still green.
**Integration checkpoint #1 (coordinator)**: `db:generate` review →
`db:migrate` → full EXISTING integration suite green (238) — proves the
refactor and migration before anyone builds on them.

**B1 — Tax + invoices.** Owns `core/src/tax/*`, `core/src/invoices/*`,
`tax.test.ts`, `invoice-number.test.ts`.
Traps: round per line HALF_UP then sum, never sum-then-round; discounts
before tax; sum-invariant odd split (D18); integer math only; FY boundary is
IST not UTC; `allocateInvoiceNumber` MUST take the caller's `tx` (it only
ever runs inside a confirming tx) and use UPDATE..RETURNING — never MAX+1,
never a SEQUENCE; invoices render from snapshots only, never live catalog.

**B2 — Promotions.** Owns `core/src/promotions/*`, console promotions
routes+pages, `promotions.test.ts`, `promotions-server.integration.test.ts`
(file authored here, RUN centrally), console promotions route tests.
Traps: limits enforced by the coupon_redemptions unique constraints, NEVER a
counter; `claimRedemption(tx, …)` takes the caller's tx; promotion row FOR
UPDATE before slot compute; pending-claim counting keeps the
`expires_at > now()` read-side filter; zod-validate conditions/effects at
write; map 23505 on slot indexes → 409; rules are data — full blueprint
§4.4 vocabulary.

**B3 — Payments.** Owns `core/src/payments/*`,
`integrations/src/payments/*`, console `/settings/payments` route+page+
test-event route, adapter unit tests, payment-accounts + payment-settings
integration files.
Traps: TWO sealed blobs (D7), AAD-bound (tenant, provider); secrets never
echoed (fingerprint only); mock driver fails CLOSED on unset NODE_ENV
(refuse in production, not "enable in dev"); HMAC verify with
timingSafeEqual against the RAW body; webhook idempotency = unique
constraint on the gateway event id, not an app check; refunds are
insert-once rows (D6); every query through withTenant.

**B4 — Cart + serviceability + customers + storefront surface.** Owns
`core/src/cart/*`, `core/src/serviceability/*`, `core/src/customers/*`,
storefront cart/serviceability routes + `/cart` `/checkout` `/order/[id]`
pages + cookie/token libs, console customers page+route,
`serviceability.test.ts`, storefront route test file, customers list bits.
Traps: tenant from Host, never payload; cart cookie httpOnly,
non-enumerable UUIDv7; visibility SELECT before trusting any variant id (FK
≠ tenancy); live commerce reads UNCACHED, pages force-dynamic; client
components import PURE barrels only (never `/server`, never @platform/db);
availability reads keep `expires_at > now()`; guest token constant-time
compare; extensionless imports.

**B5 — Orders domain + console orders.** Owns `core/src/orders/*`, console
orders routes/pages, invoice print page + shared `<InvoiceDocument>`
(renders B1's InvoiceDoc type from S0 stubs), state-machine unit test,
console orders route test file.
Traps: transition table is pure data in the client-safe barrel; ONE status
writer (`transitionOrder`) with FOR UPDATE + `WHERE status = from` belt →
0 rows = 409 (D21); illegal transition = 422 `AppError`; console buttons
derive from ORDER_TRANSITIONS ∩ manual allowlist (D12) — the server door is
the wall; order_events INSERT in the same tx; recordAudit inside the tx;
COD delivered sets paid (§4.8); enqueue only after commit.

**B-INT — Checkout orchestration + webhook + worker (serial, last).** Owns
`core/src/checkout/*`, storefront `/api/checkout` + `/api/payments/webhook`
+ checkout page wiring, worker jobs (`order-events`, `gateway-refund`,
`sweep-checkouts`) + worker `queues.ts`/`index.ts`, console nav, and the
cross-domain integration suites (`checkout*`, `cancel-refund`, worker
jobs). The ONLY lot importing multiple `/server` barrels. Has authority to
FLAG (not silently fix) stub-vs-implementation drift.
Traps: **handle BOTH `insufficient_stock` and `stock_held` from
consumeStockWithin (D2a)** — same cancel+refund path, buyer-worded message;
consume from ORDER lines, never hold rows; invoice allocation inside the
confirming tx only, at confirmation only (COD confirmation counts, D5);
webhook 2xx only after the processing tx commits; HMAC before any body use;
amount check before any state advance; enqueue + purge AFTER commit,
fail-soft; `import "./env"` stays first in worker index; every job payload
carries tenantId, handler starts with withTenant; maintenance sweep
iterates tenants (withPlatform list → withTenant each — a cross-tenant
query on the app role silently matches zero rows); jobId = order_events.id;
`upsertJobScheduler` for the sweep; delayed-job loss is survivable ONLY
because the sweep exists — build both.
Verify: typecheck + lint + unit.
**Integration checkpoint #2 (coordinator, after B1–B5 merge)**: run B1–B5's
integration files serially — proves each domain against Postgres before
orchestration lands.
**Integration checkpoint #3 (coordinator, after B-INT)**: full integration
suite (existing 238 + all new); then update PROJECT_STATUS.md verified
block with reported per-file counts, and record the two known limitations
(no credit notes for post-confirm cancels; no outbox repair sweep) + the D4
written deviation.

Dependency edges: S0 → {B1..B5} → B-INT. B4's checkout page posts to
B-INT's route — the page ships in B4 against the S0-stubbed payload type,
wired live by B-INT. File-conflict audit: `package.json`/`schema/index.ts`/
`enums.ts`/`rls.ts`/`queues.ts`/`permissions.ts`/`inventory/server.ts` are
S0-only; `worker/src/{queues,index}.ts` + nav are B-INT-only; every app
directory has exactly one owner. No two lots share a file.
