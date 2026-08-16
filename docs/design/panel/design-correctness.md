# Phase 2 Commerce Core — Correctness-First Design

Designer angle: concurrency safety, tax correctness, idempotency, failure
atomicity. Every table states its race and its guard; every flow marks its
transaction boundaries.

Composes with: `packages/core/src/inventory/server.ts` (holdStock /
releaseStock / consumeStock / getAvailability / recordMovement — merged),
`packages/db/src/rls.ts` (derived RLS + append-only-by-grant), the
write-door recipe in `docs/design/CONVENTIONS_BRIEF.md`.

Sections:
1. Schema
2. Flows (transaction boundaries marked)
3. Order state machine + domain events
4. Module map
5. Pure-function signatures (GST, partial payment, promotions)
6. API surface
7. Invoice rendering decision
8. Test matrix
9. Build partitioning

---

## 1. Schema

All new tables are **tenant-scoped** (automatic FORCE RLS via `rls.ts`)
unless explicitly justified below. Ids UUIDv7, money BIGINT paise +
`currency CHAR(3) DEFAULT 'INR'`, timestamps `timestamptz`. New schema files:
`packages/db/src/schema/commerce.ts` (customers, carts, orders, payments),
`packages/db/src/schema/billing.ts` (invoice_series, invoices, credit_notes),
`packages/db/src/schema/promotions.ts`, plus enum additions in `enums.ts` and
one control-plane table in `tenancy.ts`-adjacent `geo.ts`.

### 1.1 Enum additions (`enums.ts` — TEXT + union + CHECK, never PG enum)

```ts
ORDER_STATUSES = ["pending_payment","confirmed","processing","ready_to_ship",
  "shipped","out_for_delivery","delivered","rto_initiated","rto_delivered",
  "return_requested","return_picked","refunded","cancelled","abandoned"]
PAYMENT_STATUSES  = ["unpaid","partially_paid","paid","refund_pending","refunded"]  // orders.payment_status
FULFILMENT_STATUSES = ["unfulfilled","fulfilled","returned"]                        // Phase 2: mostly unfulfilled
GATEWAY_CODES     = ["razorpay","mock"]            // mock = dev/CI double, refuses in production (fake-carrier precedent)
PAYMENT_ATTEMPT_STATUSES = ["created","captured","failed","expired"]
REFUND_STATUSES   = ["pending","processing","processed","failed"]
PROMOTION_STATUSES = ["draft","active","paused","expired"]
INVOICE_DOC_TYPES = ["tax_invoice","bill_of_supply"]
ORDER_EVENT_TYPES = ["order.created","order.confirmed","order.cancelled","order.abandoned",
  "order.processing","order.ready_to_ship","payment.captured","payment.refund_initiated",
  "payment.refunded","promotion.cap_exceeded","order.stock_shortfall_cancelled"]
STOCK_MOVEMENT_REASONS += ["cancel_restock"]       // Phase 2; RTO reasons arrive Phase 3
CHECKOUT_PAYMENT_MODES = ["prepaid","partial_cod"] // full COD w/o advance is a store_settings gate
```

### 1.2 `customers` + `customer_addresses` — NOT guest-only

Argument: coupon conditions (`first_order`, per-customer limits) and the
Phase 3 COD risk score both key on a durable buyer identity. Guest-only
checkout forces those onto raw phone strings scattered across orders.
Buyer identity is **tenant-scoped** (unlike staff `users` — a buyer of store
A is not a buyer of store B; sharing would be a cross-tenant privacy leak).
No customer login in Phase 2; checkout upserts by phone.

```sql
customers (                              -- RLS: tenant-scoped. Mutable.
  id uuid PK v7, tenant_id uuid NOT NULL FK tenants CASCADE,
  phone_e164 text NOT NULL,              -- CHECK same regex as users
  email text, name text,
  first_order_at timestamptz,            -- set once, in the confirm tx → `first_order` condition is a column read, not a COUNT race
  created_at, updated_at, deleted_at timestamptz,   -- soft delete (blueprint §3.1)
  UNIQUE (tenant_id, phone_e164)         -- upsert key; race: two concurrent checkouts same phone → ON CONFLICT DO UPDATE, one row wins
)
customer_addresses (                     -- RLS: tenant-scoped. Live-state → real FK.
  id uuid PK v7, tenant_id, customer_id uuid NOT NULL FK customers CASCADE,
  name, phone_e164, line1, line2, city, state_code text NOT NULL, pincode text NOT NULL,
  created_at, updated_at
)
```
Orders do **not** FK to addresses — they snapshot the address as jsonb
(§1.4): an edited address book must never rewrite a shipped order's invoice.

### 1.3 `carts` + `cart_lines`

Cart ≠ checkout. The cart is a mutable scratchpad, **no holds, no price
snapshot** — prices resolve at read time; holds and snapshots happen at
checkout-start when the order is created. Cookie carries the cart id
(UUIDv7 = 74 random bits, non-enumerable; no secret needed for a cart that
contains no PII until checkout).

```sql
carts (                                  -- RLS: tenant-scoped. Live-state → CASCADE FKs.
  id uuid PK v7, tenant_id,
  customer_id uuid FK customers SET NULL,    -- attached at checkout, if known
  status text NOT NULL DEFAULT 'open',       -- open|ordered  (ordered = converted; kept briefly for back-button UX)
  created_at, updated_at, expires_at timestamptz NOT NULL   -- rolling 30d; GC sweep
)
cart_lines (
  id uuid PK v7, tenant_id, cart_id uuid NOT NULL FK carts CASCADE,
  variant_id uuid NOT NULL FK product_variants CASCADE,     -- live-state: dies with variant
  quantity int NOT NULL CHECK (quantity > 0 AND quantity <= 100),
  created_at, updated_at,
  UNIQUE (tenant_id, cart_id, variant_id)   -- race: double-tap add-to-cart → ON CONFLICT DO UPDATE qty; no dup lines
)
```
Race: add-to-cart vs. variant delete → CASCADE removes the line; checkout
re-validates every line with a visibility SELECT anyway (FK ≠ tenancy).

### 1.4 `orders` + `order_lines`

Created at **checkout-start** in `pending_payment` with lines snapshotted
(blueprint line 365) and the stock hold keyed `{type:'checkout', id: order.id}`.
Invoice numbers are NOT allocated here. Order numbers may have gaps
(abandoned checkouts) — only invoice numbers are gap-free; order numbers come
from a per-tenant `order_series` row via the same UPDATE..RETURNING shape
(race-free under concurrency, gaps tolerated on rollback are fine).

```sql
order_series (                           -- RLS: tenant-scoped. One row per tenant.
  tenant_id uuid PK, next_number bigint NOT NULL DEFAULT 1001
)
orders (                                 -- RLS: tenant-scoped. Mutable (status), but money/lines frozen after confirm.
  id uuid PK v7, tenant_id,
  order_number text NOT NULL,            -- 'ORD-1042'
  channel text NOT NULL DEFAULT 'web',
  status text NOT NULL DEFAULT 'pending_payment',   -- CHECK IN ORDER_STATUSES
  payment_status text NOT NULL DEFAULT 'unpaid',
  fulfilment_status text NOT NULL DEFAULT 'unfulfilled',
  customer_id uuid,                      -- bare uuid, NO FK: orders are history-grade — a deleted customer must not erase or block orders
  shipping_address jsonb NOT NULL,       -- SNAPSHOT {name,phone,line1,line2,city,state_code,pincode}
  billing_address jsonb,
  place_of_supply text NOT NULL,         -- GST state code, frozen at creation (from shipping address)
  buyer_gstin text,                      -- B2B
  currency char(3) NOT NULL DEFAULT 'INR',
  subtotal_paise bigint NOT NULL,        -- pre-discount, tax-inclusive sum of lines
  discount_paise bigint NOT NULL DEFAULT 0,
  shipping_paise bigint NOT NULL DEFAULT 0,
  tax_paise bigint NOT NULL DEFAULT 0,   -- sum of per-line rounded tax (incl. shipping line)
  total_paise bigint NOT NULL,
  amount_paid_paise bigint NOT NULL DEFAULT 0,
  cod_due_paise bigint NOT NULL DEFAULT 0,          -- derived-and-synced (§4.3 blueprint)
  awb_cod_synced_at timestamptz,                    -- Phase 3 uses; column exists now (append-only-ish history discipline)
  payment_mode text NOT NULL,            -- CHECK IN CHECKOUT_PAYMENT_MODES
  promotion_id uuid,                     -- bare uuid; NULL if no coupon. Read-side pending-claim key (§1.8)
  coupon_code_snapshot text,             -- what the buyer typed, frozen
  idempotency_key text,                  -- checkout-submit idempotency
  access_token_hash text NOT NULL,       -- SHA-256 of the guest-order cookie token (§6): buyer-level access, RLS only separates tenants
  checkout_expires_at timestamptz NOT NULL,         -- = hold expiry; read-side abandonment clock
  confirmed_at, cancelled_at timestamptz,
  cancel_reason text,
  created_at, updated_at,
  UNIQUE (tenant_id, order_number),
  UNIQUE (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL,  -- race: double-submit checkout → 23505 → replay winner (fingerprinted)
  CHECK (total_paise = subtotal_paise - discount_paise + shipping_paise), -- tax-inclusive: tax is inside, not added
  CHECK (amount_paid_paise >= 0 AND amount_paid_paise <= total_paise),
  INDEX (tenant_id, status, checkout_expires_at)    -- abandonment sweep + pending-claim counting
)
order_lines (                            -- RLS: tenant-scoped. Written once at checkout-start; never updated after confirm.
  id uuid PK v7, tenant_id, order_id uuid NOT NULL FK orders CASCADE,
  variant_id uuid,                       -- bare-ish: FK-free? NO — lines die with order (CASCADE on order); variant_id is a bare uuid (history: variant deletion must not touch sold lines)
  is_shipping boolean NOT NULL DEFAULT false,       -- shipping-as-line (GST composite supply)
  title_snapshot text NOT NULL, sku_snapshot text NOT NULL, hsn_snapshot text,
  quantity int NOT NULL CHECK (quantity > 0),
  unit_price_paise bigint NOT NULL,      -- tax-inclusive unit price at purchase
  line_discount_paise bigint NOT NULL DEFAULT 0,    -- coupon allocation, pre-tax
  taxable_paise bigint NOT NULL,         -- post-discount taxable value (extracted, per-line rounded)
  tax_rate_bps int NOT NULL,
  cgst_paise bigint NOT NULL DEFAULT 0, sgst_paise bigint NOT NULL DEFAULT 0, igst_paise bigint NOT NULL DEFAULT 0,
  tax_paise bigint NOT NULL,             -- = cgst+sgst+igst, per-line HALF_UP
  total_paise bigint NOT NULL            -- qty*unit − discount (tax-inclusive)
)
```
Race: catalog price edit vs. in-flight checkout → snapshot at checkout-start
wins; the buyer pays what they saw. Guard: snapshot columns, no live joins.

### 1.5 `order_events` — append-only domain event log + outbox

```sql
order_events (                           -- RLS: tenant-scoped. APPEND-ONLY by grant (add to rls.ts appendOnly set).
  id uuid PK v7, tenant_id,
  order_id uuid NOT NULL,                -- bare uuid, no FK (history precedent)
  event_type text NOT NULL,              -- CHECK IN ORDER_EVENT_TYPES
  from_status text, to_status text,      -- for transition events
  actor_type text NOT NULL,              -- staff|customer|system
  actor_user_id uuid,
  payload jsonb NOT NULL DEFAULT '{}',   -- event-specific facts (amounts, gateway ids)
  created_at timestamptz NOT NULL DEFAULT now(),
  INDEX (tenant_id, order_id, created_at)
)
```
This is the transactional **outbox**: the row is inserted in the same tx as
the state change; enqueue to BullMQ happens after commit with
`jobId = event.id` (Redis-side dedupe). At-least-once delivery: a repair
sweep re-enqueues events < 1h old (jobId dedupe absorbs the overlap);
consumers idempote on event id. No `dispatched_at` flag — append-only.

### 1.6 Payments: `gateway_accounts`, `payment_attempts`, `webhook_events`, `refunds`

```sql
gateway_accounts (                       -- RLS: tenant-scoped. Mirrors carrier_accounts exactly.
  id uuid PK v7, tenant_id,
  gateway_code text NOT NULL CHECK IN GATEWAY_CODES,
  label text NOT NULL,
  sealed_credentials text NOT NULL,      -- envelope-encrypted {key_id, key_secret}; AAD binds (tenant_id, gateway_code)
  sealed_webhook_secret text NOT NULL,   -- separate blob: webhook route needs ONLY this, never the API keys
  credential_fingerprint text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT false,
  last_verified_at timestamptz, last_error text,
  created_at, updated_at, updated_by_user_id uuid FK users,
  UNIQUE (tenant_id, gateway_code, label)
)
payment_attempts (                       -- RLS: tenant-scoped. Mutable status; one row per gateway order.
  id uuid PK v7, tenant_id,
  order_id uuid NOT NULL FK orders CASCADE,   -- live-state tied to order lifecycle
  gateway_account_id uuid NOT NULL,      -- bare uuid (credentials may be rotated/deleted; attempt is history-grade)
  gateway_code text NOT NULL,
  gateway_order_id text,                 -- razorpay order_id; set on create
  amount_paise bigint NOT NULL, currency char(3) NOT NULL DEFAULT 'INR',
  status text NOT NULL DEFAULT 'created',    -- CHECK IN PAYMENT_ATTEMPT_STATUSES
  gateway_payment_id text,               -- set on capture
  captured_at timestamptz,
  created_at, updated_at,
  UNIQUE (tenant_id, gateway_code, gateway_order_id) WHERE gateway_order_id IS NOT NULL,
  INDEX (tenant_id, order_id)
)
webhook_events (                         -- RLS: tenant-scoped. APPEND-ONLY by grant. THE idempotency ledger.
  id uuid PK v7, tenant_id,
  gateway_code text NOT NULL,
  gateway_event_id text NOT NULL,        -- x-razorpay-event-id; mock supplies its own
  event_type text NOT NULL,              -- 'payment.captured', 'refund.processed'
  order_id uuid,                         -- resolved from payload notes; bare uuid
  raw_payload jsonb NOT NULL,            -- stored BEFORE processing (bind ::text::jsonb in fixtures)
  signature_valid boolean NOT NULL,
  processed_outcome text,                -- 'confirmed'|'replayed'|'refund_recorded'|'cancelled_stock_shortfall'|'ignored'
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, gateway_code, gateway_event_id)   -- THE double-webhook guard: constraint, not app check; 23505 → ack 200
)
refunds (                                -- RLS: tenant-scoped. Mutable status (worker drives it).
  id uuid PK v7, tenant_id,
  order_id uuid NOT NULL,                -- bare uuid: refunds are financial history
  payment_attempt_id uuid NOT NULL,      -- bare uuid
  gateway_refund_id text,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  status text NOT NULL DEFAULT 'pending',    -- CHECK IN REFUND_STATUSES
  reason text NOT NULL,                  -- 'buyer_cancelled'|'merchant_cancelled'|'stock_shortfall'
  idempotency_key text NOT NULL,         -- sent to gateway as X-Razorpay-Idempotency; = refund.id
  created_at, updated_at, created_by_user_id uuid,
  UNIQUE (tenant_id, payment_attempt_id)     -- Phase 2 = full refund only: at most ONE refund per capture; double-cancel race → 23505 → replay
)
```
`processed_outcome` on an append-only table is written **in the same INSERT**
(the outcome is decided inside the processing tx, insert happens last-but-
one, before the order_events row). No UPDATE needed.

### 1.7 Invoices: `invoice_series`, `invoices`, `credit_notes` (stub)

```sql
invoice_series (                         -- RLS: tenant-scoped. THE gap-free counter (blueprint 367–393).
  tenant_id uuid NOT NULL,
  series_code text NOT NULL,             -- 'INV' | 'BOS' (Bill of Supply numbers are a separate statutory series)
  financial_year text NOT NULL,          -- '2026-27' (Apr–Mar, computed IST — a UTC-midnight FY flip misfiles a March 31 23:30 IST sale)
  prefix text NOT NULL,
  next_number int NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, series_code, financial_year)
)
invoices (                               -- RLS: tenant-scoped. APPEND-ONLY by grant.
  id uuid PK v7, tenant_id,
  order_id uuid NOT NULL,                -- bare uuid (history)
  doc_type text NOT NULL,                -- CHECK IN INVOICE_DOC_TYPES; from tenants.tax_registration_type at confirm time
  series_code text NOT NULL, financial_year text NOT NULL, number int NOT NULL,
  invoice_number text NOT NULL,          -- rendered 'INV/2026-27/0042'
  issued_at timestamptz NOT NULL DEFAULT now(),
  seller_snapshot jsonb NOT NULL,        -- legal_name, gstin, origin_state_code, address AT ISSUE TIME
  buyer_snapshot jsonb NOT NULL,         -- name, address, gstin, place_of_supply
  lines_snapshot jsonb NOT NULL,         -- the fully-computed line table incl. shipping line — the document is self-contained forever
  totals jsonb NOT NULL,                 -- {subtotal, discount, taxable, cgst, sgst, igst, total} paise
  irn text, irn_qr_payload text, irn_signed_at timestamptz,   -- IRP/IRN room, nullable, NO schema change later
  UNIQUE (tenant_id, series_code, financial_year, number),    -- belt: even a counter bug cannot mint duplicates
  UNIQUE (tenant_id, order_id)           -- one invoice per order (Phase 2: single capture confirms)
)
credit_notes (                           -- RLS: tenant-scoped. APPEND-ONLY. SCHEMA-ONLY STUB in Phase 2 (issuance = Phase 3, RTO/returns).
  id uuid PK v7, tenant_id, invoice_id uuid NOT NULL, order_id uuid NOT NULL,
  series_code text NOT NULL, financial_year text NOT NULL, number int NOT NULL,
  reason text NOT NULL, totals jsonb NOT NULL, lines_snapshot jsonb NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, series_code, financial_year, number)
)
```
Race: two concurrent webhook confirms of different orders → serialize on the
`invoice_series` row lock (UPDATE..RETURNING). Rollback returns the number.
The `UNIQUE (tenant, series, fy, number)` is the last-line guard.

### 1.8 Promotions: `promotions`, `coupon_redemptions`

```sql
promotions (                             -- RLS: tenant-scoped. Mutable.
  id uuid PK v7, tenant_id,
  code text NOT NULL,                    -- coupon code, uppercased
  status text NOT NULL DEFAULT 'draft',
  conditions jsonb NOT NULL DEFAULT '[]',    -- Condition[] (blueprint §4.4)
  effects jsonb NOT NULL DEFAULT '[]',       -- Effect[]
  max_redemptions int,                   -- NULL = unlimited
  per_customer_limit int NOT NULL DEFAULT 1,
  starts_at timestamptz, ends_at timestamptz,
  created_at, updated_at, updated_by_user_id uuid FK users,
  UNIQUE (tenant_id, code)
)
coupon_redemptions (                     -- RLS: tenant-scoped. APPEND-ONLY by grant. Written ONLY in the payment-confirm tx.
  id uuid PK v7, tenant_id,
  promotion_id uuid NOT NULL,            -- bare uuid (history)
  order_id uuid NOT NULL, customer_id uuid,
  redemption_no int NOT NULL,            -- global slot: confirmed_count+1, allocated under promotion row FOR UPDATE
  customer_use_no int,                   -- per-customer slot, same discipline
  discount_paise bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, promotion_id, order_id),                -- webhook replay / double-confirm → idempotent
  UNIQUE (tenant_id, promotion_id, redemption_no),           -- flash-sale race: two txs computing the same slot → loser 23505 → coupon_exhausted or retry
  UNIQUE (tenant_id, promotion_id, customer_id, customer_use_no) WHERE customer_id IS NOT NULL
)
```
Two-phase cap enforcement (the checkout→confirm window problem):
- **Apply/checkout-start (advisory but serialized)**: `SELECT promotions FOR
  UPDATE`, count confirmed redemptions + active *pending claims* (orders with
  this `promotion_id`, `status='pending_payment'`, `checkout_expires_at >
  now()` — the read-side-expiry pattern, exactly like holds). ≥ cap →
  `coupon_exhausted` 422. The row lock serializes concurrent checkout-starts.
- **Confirm (authoritative)**: insert the redemption row under the same row
  lock; unique constraints are the backstop. Edge: a *late webhook* (hold
  expired, others redeemed meanwhile) may push past the cap — policy: a
  captured payment is always honored; insert anyway with the next slot and
  emit `promotion.cap_exceeded` so the merchant sees the (bounded, rare)
  overshoot. Never refuse money already taken over a coupon.

### 1.9 Serviceability / pincode model

Two layers:
- **`pincode_directory`** — CONTROL PLANE (add to `PLATFORM_TABLES` with
  justification: "Static all-India postal reference data (pincode → state
  code/district). Identical for all tenants; no tenant or customer data;
  read during checkout before any buyer identity exists."). Columns:
  `pincode text PK, state_code text NOT NULL, district text`. Seeded by
  migration from the public pincode dataset. This is what makes **place of
  supply** (→ CGST/SGST vs IGST) derivable and validated from the address —
  a GST-correctness dependency, not a UX nicety.
- **Carrier serviceability** — reuse the existing tenant-scoped
  `serviceability_cache` (logistics.ts). Checkout's serviceability answer =
  pincode exists in directory AND (any enabled carrier quote in cache, stale-
  ok, OR no carrier connected → tenant setting `shipping.assume_serviceable`
  = true for Phase 2 merchants without carrier accounts). COD-eligibility =
  cached quote with payment_mode 'cod'. No new table.

Shipping fee (Phase 2): `store_settings` keys `shipping.flat_paise`,
`shipping.free_above_paise`, `shipping.cod_fee_paise` — computed as an
order line (`is_shipping = true`) at checkout-start, taxed at the max line
rate (principal supply).

### 1.10 RLS / grant classification summary

| Table | RLS | Grants |
|---|---|---|
| customers, customer_addresses, carts, cart_lines, orders, order_lines, order_series, payment_attempts, gateway_accounts, refunds, promotions, invoice_series | tenant-scoped | full CRUD |
| order_events, webhook_events, invoices, credit_notes, coupon_redemptions | tenant-scoped | **SELECT+INSERT only** (append to `appendOnly` set in rls.ts) |
| pincode_directory | PLATFORM_TABLES (justified) | SELECT (+INSERT for seeding via migrator role) |

---

## 2. Flows (── marks a transaction boundary)

Notation: `[TX]…[/TX]` = one `withTenant` transaction; everything between is
atomic. Enqueues/purges always AFTER commit.

### 2.1 Add to cart (storefront, no session actor)

1. Resolve tenant from Host; read/mint cart id cookie.
2. `[TX]` visibility SELECT variant (active, not deleted); soft availability
   read `getAvailability` (advisory only — display, don't reserve);
   upsert cart + `INSERT cart_lines ON CONFLICT (cart_id, variant_id) DO
   UPDATE SET quantity = excluded.quantity` `[/TX]`
3. **Race**: double-tap → unique constraint upsert, idempotent by nature.
   **No hold at cart stage** — carts are cheap; holds are 15-min scarce.

### 2.2 Coupon apply (cart)

1. `[TX]` load promotion by code (status active, window); evaluate
   `evaluatePromotions(cartView, [promotion], customer?)` (pure); advisory
   cap check (confirmed + pending claims) — **no lock here**, display only
   `[/TX]`. Nothing persisted but the code on the cart (`carts` gains
   `coupon_code text` — scratchpad, re-validated at checkout).

### 2.3 Checkout start → order creation + holds (THE snapshot moment)

Input: cart id, address, payment_mode, coupon code, client
`idempotency_key`. Buyer context `{tenantId, requestId}`.

1. Zod-validate; `pincode_directory` lookup → `state_code` = place of supply
   (mismatch with claimed state → 422).
2. Fast-path: `SELECT orders WHERE idempotency_key` → fingerprint-check
   (cart lines + total match) → replay winner.
3. `[TX A]`
   a. Visibility SELECT all cart line variants (price, tax_rate_bps, hsn,
      title, sku — the snapshot source), FOR no lock (prices don't race
      dangerously; snapshot freezes them).
   b. Coupon: `SELECT promotions … FOR UPDATE`; re-evaluate conditions
      (pure fn) against real cart; cap check incl. pending claims (§1.8);
      fail → `coupon_exhausted` / `coupon_not_applicable` 422.
   c. Compute: discount allocation (pure), shipping line, GST per line
      (pure, HALF_UP per line), totals; partial-payment split
      (`advance_paise`, `cod_due_paise`) from store_settings.
   d. Upsert `customers` by phone (`ON CONFLICT DO UPDATE`); attach id.
   e. Allocate order_number: `UPDATE order_series SET next_number =
      next_number + 1 WHERE tenant_id=$1 RETURNING next_number - 1`
      (INSERT the series row on first order, `ON CONFLICT DO NOTHING` then
      UPDATE).
   f. INSERT `orders` (pending_payment, checkout_expires_at = now()+15min)
      + `order_lines` (snapshots incl. shipping line).
   g. INSERT `order_events` (`order.created`).
   `[/TX A]`
4. `holdStock({tenantId}, {reference:{type:'checkout', id: order.id},
   lines})` — **its own transaction** (the module owns it). Failure
   (`insufficient_stock`) → `[TX B]` mark order cancelled(stock) — or
   simpler: **hold FIRST, order second?** No: hold reference needs the order
   id. Chosen order: create order → hold. If hold fails, TX B cancels the
   just-created order (`order.cancelled`, reason stock) and the 422 with
   buyer-worded per-line availability surfaces to the cart page. An order
   row that lived 50ms is fine; an oversold hold is not.
   **Race** (two buyers, last unit): serialized inside holdStock on the
   stock_levels row lock; loser gets `InsufficientAvailabilityError` with
   per-line availability.
5. Create `payment_attempts` row + gateway order via driver:
   `[TX C]` INSERT attempt (status created) `[/TX C]` → **gateway
   `createOrder` call OUTSIDE any tx** (network!) → `[TX D]` UPDATE attempt
   with `gateway_order_id` `[/TX D]`. Gateway call fails → attempt stays
   `created` without gateway id; buyer retries → new attempt row (old one
   expires). Mock driver: returns synthetic ids, never touches network.
6. Respond: order id, gateway checkout params (key_id public, gateway
   order id, amount). Note: `amount = advance_paise` for partial_cod.

### 2.4 Payment → webhook confirm (the money spine)

Buyer completes gateway checkout. **The redirect/callback page only ever
READS order status** (polls `GET /api/checkout/:orderId/status`) — webhook
is the sole writer (locked decision).

Webhook route (`POST /api/webhooks/payments/[gatewayCode]`, storefront app,
Host-resolved tenant):
1. Bounded raw-body read; unseal `sealed_webhook_secret` for the tenant's
   gateway account; **HMAC verify against the RAW body before parsing**.
   Invalid → 401, log, do NOT store payload as trusted.
2. Parse; extract `gateway_event_id`, event type, gateway_order_id →
   resolve `payment_attempts` row → order id.
3. `confirmPaymentFromWebhook(ctx, parsed)`:

```
[TX 1 — the full confirm, attempted first]
  INSERT webhook_events (…, processed_outcome:'confirmed')
      ← 23505 on (gateway, event_id)? → REPLAY: rollback, respond 200. Double-webhook dead.
  SELECT orders FOR UPDATE                    ← serializes vs. abandon sweep & double-confirm
  order already confirmed/cancelled? → outcome 'replayed'/'ignored'; commit event row only
  assertTransition(pending_payment → confirmed)
  UPDATE payment_attempts (captured, gateway_payment_id, captured_at)
  UPDATE orders amount_paid += captured; payment_status = paid|partially_paid
  consumeStock({reference:{type:'checkout',id:order.id}}, ORDER lines)
      ← the ORDER is the authority, never hold rows; both failure codes handled (§2.5)
  coupon? INSERT coupon_redemptions under promotions FOR UPDATE (§1.8)
  customers.first_order_at ??= now()
  doc = tenant.tax_registration_type == 'regular' ? tax_invoice : bill_of_supply
  UPDATE invoice_series … RETURNING           ← gap-free number, INSIDE this tx; rollback returns it
  INSERT invoices (full snapshots — self-contained document)
  UPDATE orders status='confirmed', confirmed_at
  INSERT order_events ('payment.captured'), ('order.confirmed')
[/TX 1]
after commit: enqueue order_events jobs (jobId=event id) on `order-events`;
purge storefront cache tags (availability changed); respond 200.
```

**Failure atomicity answers:**
- *Webhook races redirect*: redirect only reads; no writer conflict exists.
- *Double webhook / gateway retry*: `webhook_events` unique constraint —
  first tx wins, replay acks 200 without side effects.
- *Two different events (captured + captured retry with new event id)*:
  order FOR UPDATE + status guard → second is 'replayed', no double consume,
  no second invoice (also hard-stopped by `UNIQUE (tenant, order_id)` on
  invoices).
- *Crash after TX 1 commit, before enqueue*: outbox repair sweep re-enqueues
  recent order_events (jobId dedupe); events are never lost, at-least-once.
- *Webhook arrives while abandon sweep holds the order row*: FOR UPDATE on
  orders serializes them; whoever wins, the loser sees the new status and
  no-ops (sweep skips non-pending; webhook sees 'abandoned' → §2.6 late-
  payment path).

### 2.5 Confirm when stock is gone (hold expired, unit stolen)

`consumeStock` inside TX 1 throws → TX 1 **rolls back entirely** (invoice
number returned, no redemption, no movements). Then:

```
[TX 2 — money is never hostage to stock]
  INSERT webhook_events (processed_outcome:'cancelled_stock_shortfall')
  UPDATE payment_attempts captured
  UPDATE orders amount_paid, payment_status='refund_pending'
  assertTransition(pending_payment → cancelled); cancelled_at, cancel_reason='stock_shortfall'
  INSERT refunds (full amount captured, reason 'stock_shortfall', status pending)
      ← UNIQUE (tenant, payment_attempt_id) makes a webhook-retry race insert-once
  INSERT order_events ('payment.captured'), ('order.stock_shortfall_cancelled'), ('payment.refund_initiated')
[/TX 2]
after commit: enqueue refund job (worker calls gateway refund with
idempotency key = refund.id); respond 200.
```
Policy (locked here): **any** line short → cancel whole order + full
auto-refund. Partial fulfilment of a paid order is a Phase 3 merchant
decision, not a Phase 2 default. `stock_held` from consumeStock (some other
reference holds the remainder) gets the same treatment — for the buyer path
both codes mean "you didn't get the unit"; the buyer-worded message replaces
the adjustment-shaped one (PHASE2_FOLLOWUPS contract).

### 2.6 Abandoned expiry + late payment

Worker sweep (`sweep-checkouts`, every 5 min, maintenance fan-out per
tenant): for each order `status='pending_payment' AND checkout_expires_at <
now() - 5min` (grace period — a webhook in flight at expiry+ε should win):
```
[TX per order] SELECT order FOR UPDATE; still pending? →
  status='abandoned'; INSERT order_events('order.abandoned') [/TX]
after commit: releaseStock(reference) (idempotent; usually already expired
read-side — this is hygiene), enqueue events.
```
**Late webhook after abandonment**: TX 1's status guard sees 'abandoned' —
treat as §2.5 TX 2 but from 'abandoned': record money, transition
`abandoned → cancelled` is NOT in the table; instead policy: attempt
**revival** — `abandoned → confirmed` IS a legal transition iff
consumeStock succeeds (stock may well still be there); otherwise
abandoned → cancelled(stock_shortfall) + auto-refund. Both transitions are
in the state table (§3) so this is enforced, not improvised.

### 2.7 Cancel / refund (Phase 2 scope: full refund, pre-shipment only)

Console (staff, `orders:write`) or buyer (own pending order):
```
[TX] SELECT order FOR UPDATE; assertTransition(status → cancelled)
       — legal from pending_payment/confirmed/processing ONLY (pre-shipment)
     amount_paid > 0? INSERT refunds(full amount, pending) + payment_status='refund_pending'
     order confirmed already (stock consumed)? INSERT restock movements via
       inventory restockOrder(tx-embedded write door, reason 'cancel_restock',
       reference {type:'order', id}) — ledger truth restored in the SAME tx
     pending_payment still? releaseStock after commit instead (no movements exist)
     INSERT order_events('order.cancelled', 'payment.refund_initiated'?)
     recordAudit(...) [/TX]
after commit: enqueue refund job + events; purge availability tags.
```
Worker refund job: gateway `createRefund(idempotencyKey=refund.id)` →
`[TX]` refunds.status='processing' `[/TX]`; terminal truth arrives via
`refund.processed` webhook → `[TX]` webhook_events insert (unique), refunds
status='processed', order payment_status='refunded',
order_events('payment.refunded') `[/TX]`.
**Stubs for Phase 3**: credit_notes table exists unissued; RTO reasons and
`return_*` transitions are in the state table but no route or driver wires them;
`awb_cod_synced_at` column exists, unused.

### 2.8 Gateway drivers (BYOG)

Interface in `packages/core/src/payments/index.ts` (pure):
```ts
interface PaymentGatewayDriver {
  code: GatewayCode;
  createOrder(creds, {amountPaise, currency, receipt, notes}): Promise<{gatewayOrderId}>;
  verifyWebhookSignature(webhookSecret, rawBody: string, signature: string): boolean;  // timing-safe HMAC-SHA256
  parseWebhook(rawBody): ParsedGatewayEvent;   // {eventId, type, gatewayOrderId, gatewayPaymentId, amountPaise}
  createRefund(creds, {gatewayPaymentId, amountPaise, idempotencyKey}): Promise<{gatewayRefundId}>;
}
```
Implementations in `packages/integrations/src/payments/razorpay.ts` and
`mock.ts`. Registry gate = fake-carrier precedent: mock **refuses when
NODE_ENV === 'production' or unset** (fail closed). Mock driver's "capture"
is a dev-only console/test action that POSTs a correctly-HMAC'd webhook to
the storefront endpoint — so dev/CI exercise the REAL webhook path, not a
bypass.

---

## 3. Order state machine + domain events

### 3.1 Transition table (pure data, `packages/core/src/orders/index.ts`)

```ts
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ["confirmed", "abandoned", "cancelled"],
  abandoned:       ["confirmed", "cancelled"],   // late-webhook revival / late-money refund path (§2.6)
  confirmed:       ["processing", "cancelled"],
  processing:      ["ready_to_ship", "cancelled"],
  ready_to_ship:   ["shipped"],                  // wired Phase 3 (AWB); table complete now
  shipped:         ["out_for_delivery"],
  out_for_delivery:["delivered", "rto_initiated"],
  rto_initiated:   ["rto_delivered"],
  delivered:       ["return_requested"],
  return_requested:["return_picked"],
  return_picked:   ["refunded"],
  rto_delivered:   [], refunded: [], cancelled: [],
};
export function assertTransition(from: OrderStatus, to: OrderStatus): void; // throws AppError 422 code 'invalid_transition'
```

Phase 2 wires: pending_payment→{confirmed,abandoned,cancelled},
abandoned→{confirmed,cancelled}, confirmed→{processing,cancelled},
processing→{ready_to_ship,cancelled}. Everything from ready_to_ship onward
exists in the table (console shows the full ladder) but only manual console
transitions are exposed; courier-driven transitions arrive Phase 3.

### 3.2 Where enforced

ONE write door: `transitionOrder(ctx, {orderId, to, reason?})` in
`packages/core/src/orders/server.ts`. Inside its tx: `SELECT orders FOR
UPDATE` → `assertTransition` → UPDATE → side effects for that edge (restock
on cancel-after-confirm, refund row creation) → `order_events` INSERT →
audit. The confirm flow (§2.4) and abandon sweep call the same
`assertTransition` inside their own transactions — the table is the single
authority; the FOR UPDATE on the order row is what makes check-then-set
race-free (two concurrent transitions serialize; the loser re-reads and gets
`invalid_transition` 422 or no-ops if already at target).

### 3.3 Domain events

- **Table**: `order_events` (§1.5) — the transactional outbox, written in
  the same tx as the change. History AND delivery source.
- **Queue**: one new BullMQ queue `order-events` in
  `packages/core/src/queues.ts` (`QUEUE_NAMES.orderEvents`), plus a
  `payments` queue for outbound gateway work (refunds, reconcile polls).
- **Payload shape** (`TenantJob`):
```ts
type OrderEventJob = {
  tenantId: string;
  eventId: string;        // = order_events.id → consumer idempotency key
  orderId: string;
  eventType: OrderEventType;
  occurredAt: string;     // ISO
  payload: Record<string, unknown>;   // amounts, gateway ids, from/to status
};
// enqueued with { jobId: eventId } — Redis dedupes re-enqueues
```
- **Producers**: never enqueue inside a tx. Pattern: collect event ids in the
  write-door return, enqueue after `withTenant` resolves, fail-soft (repair
  sweep is the backstop: `maintenance` job re-enqueues events < 1h old).
- **Consumers (Phase 2)**: `apps/worker/src/jobs/order-events.ts` — a
  dispatcher that logs structured JSON per event and fans out to handlers;
  Phase 2 handlers: none but the log + a hook point for messaging (Phase 4)
  and analytics. Consumers must be idempotent on `eventId` by contract
  (documented in the module header) because delivery is at-least-once.
- **Never inline**: checkout/webhook handlers do zero messaging/analytics —
  a WhatsApp timeout can never fail a payment (blueprint §4.2).

---

## 4. Module map

Every new domain gets the pure/`server` barrel split, registered in
`packages/core/package.json#exports`.

### New files — `packages/db`
| File | Responsibility |
|---|---|
| `src/schema/commerce.ts` | customers, customer_addresses, carts, cart_lines, orders, order_lines, order_series, order_events |
| `src/schema/payments.ts` | gateway_accounts, payment_attempts, webhook_events, refunds |
| `src/schema/billing.ts` | invoice_series, invoices, credit_notes |
| `src/schema/promotions.ts` | promotions, coupon_redemptions |
| `src/schema/geo.ts` | pincode_directory (control-plane, justified) |

### Changed files — `packages/db` (minimal)
| File | Change |
|---|---|
| `src/schema/enums.ts` | add unions of §1.1; extend STOCK_MOVEMENT_REASONS with `cancel_restock` (CHECK migration) |
| `src/schema/index.ts` | re-export new schema files |
| `src/rls.ts` | `appendOnly` += order_events, webhook_events, invoices, credit_notes, coupon_redemptions; `PLATFORM_TABLES` += pincode_directory (justification text) |

### New files — `packages/core`
| File | Responsibility |
|---|---|
| `src/tax/index.ts` | PURE: GST engine — `computeOrderTax`, FY computation (IST), rounding helpers, state-code table |
| `src/orders/index.ts` | PURE: statuses, ORDER_TRANSITIONS, `assertTransition`, event types, totals invariant helpers |
| `src/orders/server.ts` | write doors: `createOrderFromCheckout`, `transitionOrder`, `cancelOrder`, abandon sweep helper; order read queries |
| `src/cart/index.ts` | PURE: cart view types, line-merge logic, `CHECKOUT_PAYMENT_MODES` |
| `src/cart/server.ts` | cart CRUD (upsert line, set coupon code, get cart view with live prices/availability) |
| `src/payments/index.ts` | PURE: `PaymentGatewayDriver` interface, `ParsedGatewayEvent`, partial-payment math (`splitAdvance`), gateway codes |
| `src/payments/server.ts` | `confirmPaymentFromWebhook` (TX 1/TX 2 of §2.4–2.5), `createPaymentAttempt`, `recordRefundProcessed`, gateway-account CRUD (envelope seal/unseal via existing crypto), driver registry with fail-closed mock gate |
| `src/promotions/index.ts` | PURE: Condition/Effect types, `evaluatePromotions`, `allocateDiscount` (per-line, largest-remainder) |
| `src/promotions/server.ts` | promotion CRUD, `checkCouponCap` (FOR UPDATE + pending claims), `recordRedemption` (confirm-tx embedded, takes `tx`) |
| `src/billing/index.ts` | PURE: invoice number rendering, doc-type selection, invoice document view model |
| `src/billing/server.ts` | `allocateInvoiceNumber(tx, …)` (UPDATE..RETURNING; takes caller's tx — it is only ever called inside a confirm tx), `getInvoice`, series CRUD |
| `src/serviceability/index.ts` | PURE: pincode validation, place-of-supply resolution types |
| `src/serviceability/server.ts` | `checkPincode` (directory lookup + serviceability_cache read, stale-ok), shipping-fee resolution from store_settings |
| `src/customers/server.ts` | `upsertCustomerByPhone(tx, …)`, address book CRUD (pure barrel is types-only, may live in orders/index) |

### Changed files — `packages/core` (minimal)
| File | Change |
|---|---|
| `src/queues.ts` | `QUEUE_NAMES` += `orderEvents: "order-events"`, `payments: "payments"` |
| `src/inventory/server.ts` | ONE addition: export `restockOrder(tx, {reference, lines, reason})` wrapping the private `applyMovement` for cancel-restock inside the caller's tx; reword `StockHeldError.publicMessage` for the buyer path (PHASE2_FOLLOWUPS) |
| `src/index.ts` / `package.json` | register new barrels |
| permissions module | add `orders:read/write`, `payments:read/write`, `promotions:read/write`, `billing:read` |

### New files — `packages/integrations`
| File | Responsibility |
|---|---|
| `src/payments/razorpay.ts` | Razorpay driver: Orders API create, HMAC-SHA256 verify (timing-safe), webhook parse, refunds API |
| `src/payments/mock.ts` | mock driver: synthetic ids, deterministic secrets, `simulateCapture()` that POSTs a signed webhook; throws in production |
| `src/payments/index.ts` | driver registry keyed by GatewayCode (carrier-registry pattern) |

### New files — `apps/storefront`
Cart/checkout pages + API routes (§6), `src/lib/commerce.ts` (tenant-from-
Host buyer context helper shared by the routes).

### New files — `apps/console`
Orders list/detail, promotions CRUD, payment settings, invoice print page +
API routes (§6).

### New files — `apps/worker`
| File | Responsibility |
|---|---|
| `src/jobs/sweep-checkouts.ts` | abandon expired pending_payment orders (maintenance fan-out, §2.6) |
| `src/jobs/order-events.ts` | order-events queue consumer/dispatcher |
| `src/jobs/process-refunds.ts` | payments queue: gateway refund calls with backoff, circuit-breaker, redacted logs |
| `src/jobs/reconcile-payments.ts` | poll-fallback: orders pending >10min with a created attempt → gateway fetch → feed the same confirm door |

### Changed files — `apps/worker` (minimal)
`src/queues.ts` (+2 queues), `src/index.ts` (register workers BELOW `import "./env"`).

---

## 5. Pure-function signatures + edge cases

### 5.1 GST engine (`packages/core/src/tax/index.ts`)

```ts
type TaxContext = {
  registrationType: TaxRegistrationType;   // unregistered|regular|composition
  sellerStateCode: string;                  // tenants.origin_state_code
  placeOfSupply: string;                    // delivery address state code
  pricesInclusive: boolean;                 // default true
};
type TaxableLine = { taxablePaise: bigint; taxRateBps: number };   // taxable = post-discount
type LineTax = { taxablePaise: bigint; cgstPaise: bigint; sgstPaise: bigint;
                 igstPaise: bigint; taxPaise: bigint };

export function computeLineTax(line: TaxableLine, ctx: TaxContext): LineTax;
export function computeOrderTax(lines: TaxableLine[], ctx: TaxContext):
  { lines: LineTax[]; totalTaxPaise: bigint; docType: InvoiceDocType };
export function roundHalfUpPaise(numer: bigint, denom: bigint): bigint;  // integer-only half-up: (2n+d)/(2d) floor trick — NO floats anywhere
export function financialYearIST(at: Date): string;                      // '2026-27'; Apr 1 IST boundary
export function extractInclusiveTax(grossPaise: bigint, rateBps: number): bigint; // gross*r/(10000+r), HALF_UP
```
Edge cases (each is a pinned unit test):
- unregistered/composition → zero tax on every line, docType bill_of_supply,
  even when variants carry tax_rate_bps.
- intra-state odd split: tax 15 paise → CGST 8 + SGST 7? NO — split the
  RATE not the tax: CGST = round(taxable×r/2), SGST = round(taxable×r/2),
  each independently HALF_UP (statutory practice); total may differ 1p from
  IGST-equivalent — that is correct and documented.
- inclusive extraction at 18%: ₹999.00 gross → tax = HALF_UP(99900×1800 /
  11800) = 15239p (₹152.39) — the test pins the exact integer.
- rounding exactly .5 paise → HALF_UP (away from zero for positives).
- rate 0 (exempt HSN) → zero tax line, still on the invoice.
- shipping line taxed at MAX(line rates) (principal supply proxy — document
  the simplification; composite-supply nuance is a CA question flagged in
  the doc header).
- per-line-then-sum vs sum-then-round divergence case pinned explicitly.
- discount applied BEFORE extraction: taxable = gross − discount, then
  extract.
- null hsn → allowed on line, invoice renders blank HSN (B2C small).
- FY boundary: 2026-03-31T19:00:00Z = Apr 1 00:30 IST → '2026-27'.

### 5.2 Partial payment (`packages/core/src/payments/index.ts`)

```ts
type AdvancePolicy = { advanceBps?: number; fixedAdvancePaise?: bigint;
                       minAdvancePaise: bigint };   // from store_settings
export function splitAdvance(totalPaise: bigint, policy: AdvancePolicy):
  { advancePaise: bigint; codDuePaise: bigint };
// clamp(round(total×pct) OR fixed, min=minAdvance, max=total); cod = total − advance
```
Edge cases: advance > total → clamp to total (cod 0 → effectively prepaid);
min > total → advance = total; both pct and fixed set → fixed wins (or 422
at settings-write time — pick 422, invalid config should not guess);
total 0 (100% coupon) → advance 0, order confirms without a gateway attempt
(flow branch: zero-total checkout skips §2.3 step 5 and confirms via a
synthetic internal event — still through the same confirm door, same invoice
allocation; pinned test).

### 5.3 Promotions (`packages/core/src/promotions/index.ts`)

```ts
type CartView = { lines: {variantId, productId, categoryIds, quantity, unitPricePaise}[];
                  subtotalPaise: bigint; channel: Channel };
type CustomerView = { id: string; firstOrderAt: Date | null } | null;
export function evaluatePromotions(cart: CartView, promotions: Promotion[],
  customer: CustomerView, now: Date):
  { applied: AppliedDiscount[]; rejected: {promotionId, reason: RejectReason}[] };
export function allocateDiscount(discountPaise: bigint,
  lines: {linePaise: bigint}[]): bigint[];   // largest-remainder proportional split; sum EXACTLY equals input
```
Edge cases (100% branch coverage mandated):
- every Condition type true/false; unknown condition type in jsonb →
  rejected `unknown_condition` (forward-compat, never throw).
- percent_off with maxDiscountPaise cap hit / not hit; bps 10000 (=100%).
- flat_off > subtotal → clamp to subtotal (discount never exceeds value).
- free_shipping → discount applies to the shipping line only, before its tax.
- buy_x_get_y: qty exactly x, x−1, 2x (two free), get-variant absent from
  cart → no effect; get qty capped at cart qty.
- first_order with customer null (guest) → condition false, rejected
  `requires_customer`.
- window: starts_at in future / ends_at passed / both null.
- Phase 2 policy: ONE coupon per order (stacking is a Phase 3 decision);
  evaluate receives exactly the typed code's promotion.
- allocateDiscount: 100p across 3 equal lines → 34/33/33; zero-price line gets 0.
- rejection reasons are the API contract: `coupon_expired`,
  `coupon_not_started`, `conditions_not_met`, `coupon_exhausted`,
  `requires_customer`, `unknown_condition`.

---

## 6. API surface

All routes: shared error envelope `{error:{code,message,details?},requestId}`;
zod-parse + 1 MiB body bound; `rejectMalformedId` on path ids. Storefront
routes resolve tenant from Host (buyer context, no session actor); console
routes go through `handleCatalogWrite` with the named permission.

### Storefront (`apps/storefront`)

| Path | Method | Authz | Zod payload (shape) |
|---|---|---|---|
| `/api/cart` | GET | cart-id cookie | — → cart view (live prices, availability, coupon preview) |
| `/api/cart/lines` | POST | cookie | `{variantId: uuid, quantity: int 1..100}` (upsert; 0 = remove) |
| `/api/cart/coupon` | PUT/DELETE | cookie | `{code: string.max(64)}` |
| `/api/serviceability` | GET | none | `?pincode=6digits&mode=prepaid\|cod` → `{serviceable, codAvailable, stateCode, etaDays?}` |
| `/api/checkout` | POST | cookie | `{cartId, idempotencyKey: string, address:{name,phone,line1,line2?,city,stateCode,pincode}, email?, paymentMode, couponCode?, buyerGstin?}` → `{orderId, orderNumber, payment:{gatewayCode, gatewayOrderId, keyId, amountPaise} \| null}` |
| `/api/checkout/[orderId]/status` | GET | cookie (order must carry this cart's customer/cookie binding) | — → `{status, paymentStatus}` (the redirect page POLLS this; it never writes) |
| `/api/checkout/[orderId]/cancel` | POST | cookie binding | `{}` — buyer cancel, pending_payment only |
| `/api/webhooks/payments/[gatewayCode]` | POST | **HMAC signature** (verify raw body BEFORE parse; 401 on fail) | raw gateway payload → 200 after commit only |
| Pages: `/cart`, `/checkout`, `/checkout/[orderId]/return` (poll + result), `/orders/[orderId]` (confirmation, invoice link) | | | all force-dynamic |

### Console (`apps/console`)

| Path | Method | Permission | Payload |
|---|---|---|---|
| `/api/orders` | GET | `orders:read` | `?status=&q=&limit=&offset=` |
| `/api/orders/[id]` | GET | `orders:read` | — (order + lines + events + payments + invoice ref) |
| `/api/orders/[id]/transition` | POST | `orders:write` | `{to: OrderStatus, reason?: string}` → transitionOrder |
| `/api/orders/[id]/cancel` | POST | `orders:write` | `{reason: string}` → cancelOrder (refund + restock path) |
| `/api/promotions` | GET/POST | `promotions:read/write` | POST `{code, conditions: Condition[], effects: Effect[], maxRedemptions?, perCustomerLimit, startsAt?, endsAt?, status}` (zod discriminated unions over Condition/Effect) |
| `/api/promotions/[id]` | PUT/DELETE | `promotions:write` | same shape; DELETE = pause not erase once redeemed |
| `/api/settings/payments` | GET/PUT | `payments:write` | PUT `{gatewayCode, label, credentials:{keyId,keySecret}, webhookSecret, isEnabled}` → sealed; GET returns fingerprint only, NEVER credentials |
| `/api/settings/payments/[id]/verify` | POST | `payments:write` | `{}` — enqueue a gateway ping job |
| `/api/settings/invoicing` | GET/PUT | `billing:read`/`orders:write` | `{seriesCode, prefix}` + advance-payment policy keys |
| `/api/invoices/[id]` | GET | `billing:read` | — invoice document view-model JSON |
| Pages: `/orders`, `/orders/[id]`, `/promotions`, `/promotions/[id]`, `/settings/payments`, `/settings/invoicing`, `/invoices/[id]/print` (print-CSS document, §7) | | | |

Notes:
- The webhook route is in the **storefront** app because it is Host-resolved
  per tenant (each merchant registers `https://{their-domain}/api/webhooks/
  payments/razorpay` at Razorpay) — no tenant id in the URL, no enumeration.
- Buyer order access binding: `orders` carries a `cart_id`/cookie-derived
  `access_token_hash` (uuid minted at checkout, stored hashed, set as an
  httpOnly cookie scoped to `/orders`) — guest buyers can see exactly their
  own order, nothing else. RLS alone does not separate two buyers of one
  tenant; this token does.

---

## 7. Invoice rendering decision

**Recommendation: print-CSS HTML page** (`/invoices/[id]/print` in console,
plus the buyer-facing copy on the storefront order page), rendered as a
React server component from the invoice row's snapshots ONLY (never live
catalog — the row is self-contained by design, §1.7). "Download PDF" =
browser print-to-PDF in Phase 2.

| Option | Verdict | Why |
|---|---|---|
| **Print-CSS HTML** | **PICK** | Zero new dependencies on a self-hosted VPS with no headroom (no VPS even exists yet). The GST invoice is a tabular document — HTML+CSS is its native medium; A4 `@page` rules, `page-break-inside: avoid` on line rows. The view model (`billing/index.ts`) is pure and testable. Correctness lives in the data, not the renderer. |
| pdfkit / @react-pdf | reject | Hand-placed coordinates for a dense tax table = a second layout engine to test; every GST field tweak is geometry work; still ~2–5 MB deps. No correctness gain. |
| Headless Chromium (playwright/puppeteer) | defer | ~300 MB image + ~150 MB RSS per render on a small VPS, a crashable browser pool to babysit. Phase 3 needs server-side PDFs (email/WhatsApp attachments) — add it THEN as a worker job that prints the exact same `/print` URL, which is why HTML-first is also the migration path, not a dead end. |

The IRN/QR columns (§1.7) render as an optional block in the same template
when present — no rework at e-invoicing time.

---

## 8. Test matrix

Unit = `packages/core/tests/*.test.ts` (no DB). Integration =
`*.integration.test.ts` against the shared Docker PG, centrally serialized.

| Suite (file) | Pins | ~Count |
|---|---|---|
| `core/tests/tax.test.ts` (unit) | every §5.1 edge: inclusive/exclusive extraction, per-line HALF_UP then sum (incl. the divergence case), CGST/SGST independent rounding, IGST vs intra split by state codes, Bill of Supply zero-tax, shipping-line rate, discount-before-tax, FY IST boundary, rate 0, exact pinned paise values | 40 |
| `core/tests/promotions.test.ts` (unit) | 100% branch: every Condition × true/false, every Effect, caps/clamps, buy_x_get_y quantization, unknown-condition rejection, allocateDiscount exactness (sum invariant, largest remainder), rejection-reason contract | 45 |
| `core/tests/order-transitions.test.ts` (unit) | full transition table exhaustively (14×14 legal/illegal), assertTransition error shape, event-type mapping per edge | 25 |
| `core/tests/partial-payment.test.ts` (unit) | splitAdvance clamps, zero-total, config conflicts | 10 |
| `core/tests/payments-drivers.test.ts` (unit) | HMAC verify (timing-safe, tampered body/sig), webhook parse fixtures (captured/refund/unknown), mock production-refusal (NODE_ENV unset AND 'production'), invoice-number rendering | 15 |
| `core/tests/checkout.integration.test.ts` | order creation snapshot correctness (price edit after checkout does not change lines); idempotency-key replay + fingerprint mismatch 422; hold placed keyed on order id; last-unit race: two concurrent checkouts → one `insufficient_stock`; coupon cap under concurrency (promotion FOR UPDATE): N parallel checkout-starts at cap → exactly cap succeed; pending-claim expiry frees the slot | 20 |
| `core/tests/payment-confirm.integration.test.ts` | THE spine: double-webhook (same event id, parallel) → one confirm, one 200-replay, ONE invoice, ONE set of sale movements; invoice numbers gap-free under 10 parallel confirms (distinct orders, sequential numbers, no dup — the UNIQUE backstop untriggered); rollback returns number (forced failure after allocation); consume-after-expiry stolen-unit → TX 2 path: order cancelled, refund row, money recorded, NO invoice, NO redemption; stock_held path same; late-webhook-after-abandon revival; redemption UNIQUE(order) replay-safe; first_order_at set once | 30 |
| `core/tests/cancel-refund.integration.test.ts` | cancel pre/post-confirm (restock movements exist with reference, ledger reconciles), double-cancel race → one refund row (UNIQUE), illegal cancel after ready_to_ship → 422, refund webhook → processed + payment_status refunded | 12 |
| `apps/console/tests/orders-routes.integration.test.ts` | authz per permission, transition route → 422 envelope on illegal, gateway settings never echo credentials (fingerprint only), promotion zod unions reject malformed jsonb | 15 |
| `apps/storefront/tests/checkout-routes.integration.test.ts` | Host-resolved tenancy (two tenants, same paths, zero bleed), webhook 401 on bad HMAC BEFORE any write, webhook 200-after-commit ordering, cart upsert idempotency, serviceability pincode→state, order access token (foreign token → 404) | 18 |
| `apps/worker/tests/sweeps.integration.test.ts` | abandon sweep grace period (in-flight webhook wins), outbox repair re-enqueue jobId dedupe, refund job idempotency key pass-through | 8 |
| `apps/storefront/tests/` render (runDynamicRender) | checkout page availability, order confirmation shows snapshots, invoice print page renders from invoice row with catalog rows DELETED (the snapshot proof) | 6 |

Total ≈ 135 unit + 109 integration new. Report per-file counts to the
coordinator (PROJECT_STATUS.md pins 325/238 today).

---

## 9. Build partitioning (~6 builders, disjoint files, serial spine)

```
S1 (serial, first)  ──►  B2 B3 B4 B5 (parallel)  ──►  S6 (serial)  ──►  B7 (parallel with S6 tail)
```

**S1 — Schema + enums + RLS (serial spine, one builder, merges first).**
Owns: `packages/db/src/schema/{commerce,payments,billing,promotions,geo}.ts`,
`enums.ts`, `schema/index.ts`, `rls.ts` (appendOnly + PLATFORM_TABLES),
pincode seed migration, `cancel_restock` CHECK migration,
`packages/core` permission names + `queues.ts` additions. Coordinator runs
db:generate/db:migrate. EVERYTHING else depends on this — nothing parallel
until merged.

**B2 — Tax + billing domain.** Owns `core/src/tax/*`, `core/src/billing/*`,
`core/tests/tax.test.ts`, billing unit tests. Pure-heavy; `allocateInvoiceNumber(tx,…)`
takes a Tx — no cross-module imports needed.

**B3 — Promotions domain.** Owns `core/src/promotions/*`, its unit tests.
`recordRedemption(tx,…)` and `checkCouponCap(tx,…)` take a Tx (checkout
orchestration calls them inside its transactions later).

**B4 — Payments domain + drivers.** Owns `core/src/payments/*` (interface,
splitAdvance, driver registry, gateway-account CRUD with envelope crypto),
`integrations/src/payments/*`, driver unit tests. NOT `confirmPaymentFromWebhook`
(that's S6 — it composes everyone).

**B5 — Cart + customers + serviceability + state machine tables.** Owns
`core/src/cart/*`, `core/src/customers/*`, `core/src/serviceability/*`,
`core/src/orders/index.ts` (PURE ONLY: statuses, transition table,
assertTransition, event types) + transition unit tests, storefront cart
pages/routes (`/cart`, `/api/cart*`, `/api/serviceability`).

**S6 — Checkout + confirm orchestration (serial, after B2–B5 merge; the
correctness spine gets ONE owner).** Owns `core/src/orders/server.ts`
(createOrderFromCheckout, transitionOrder, cancelOrder),
`core/src/payments/server.ts::confirmPaymentFromWebhook`, the ONE
`inventory/server.ts` change (restockOrder export + StockHeldError rewording),
storefront `/api/checkout*`, webhook route, checkout/return pages, and the
two heavyweight integration suites (checkout, payment-confirm, cancel-refund).
This is deliberately serial: every §2 race lives here; splitting it across
builders is how double-invoice bugs are born.

**B7 — Console + worker surfaces (parallel with S6's late tests, disjoint
files).** Owns console orders/promotions/settings/invoice-print pages +
routes + their integration tests, worker jobs (`sweep-checkouts`,
`order-events`, `process-refunds`, `reconcile-payments`) + worker tests,
invoice print-CSS template (renders `billing/index.ts` view model — pure
import only, no S6 dependency).

File-ownership conflicts checked: `core/package.json#exports` and
`schema/index.ts` are touched only by S1; `worker/src/{index,queues}.ts`
only by B7; `inventory/server.ts` only by S6. Builders run unit tests +
typecheck + lint only; integration runs are coordinator-serialized.

---

*End of design. — correctness-first designer*
