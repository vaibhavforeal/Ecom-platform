# Phase 2 Commerce Core — Design (minimal-diff / maximal-reuse angle)

Designer angle: smallest schema and module surface that satisfies the spec;
reuse the merged inventory holds as THE cart reservation mechanism; reuse
audit_log precedent, envelope crypto, BullMQ fleet, purge pipeline. Fewer
tables with clear semantics over speculative generality.

Spec sources honored: PLATFORM_BLUEPRINT.md §3–§5.4, docs/PHASE2_FOLLOWUPS.md,
docs/design/CONVENTIONS_BRIEF.md. Locked decisions taken as given.

## What is explicitly NOT built in Phase 2

- **Customer login / accounts / address books.** Guest checkout only. A lean
  `customers` row IS created (upsert by phone) — argued in §1.1 — but it has
  no credentials, no sessions, no address table. `customer_login` OTP purpose
  already exists in enums for Phase 4; nothing here blocks it.
- **Credit notes / RTO reversal documents.** `invoices.doc_type` is a text
  union with room; the cancel path stops at "full refund pre-shipment".
- **IRN / e-invoicing.** Nullable columns reserved on `invoices` (§1.6).
- **COD-at-doorstep collection reconciliation** (`awb_cod_synced_at` column
  exists, nothing writes it until Phase 3 logistics).
- **GSTR-1 export, per-customer RTO risk score, WhatsApp messaging** —
  consumers of the domain events, later phases.
- **Multi-currency, multi-location checkout** — `currency` columns exist,
  default location only (matches inventory module's Phase 5 note).
- **A `pincode_zones` table** — serviceability reuses `serviceability_cache`
  + carrier adapters + two `store_settings` keys (§1.9).
- **A generic "documents" or "transactions" abstraction** — invoices and
  payments are concrete tables.

Sections:
1. Schema
2. Flows with transaction boundaries
3. Order state machine + domain events
4. Module map
5. Pure-function signatures (GST, partial payment, promotions)
6. API surface
7. Invoice rendering decision
8. Test matrix
9. Build partitioning

---

# 1. Schema

Three new schema files in `packages/db/src/schema/`: `commerce.ts` (customers,
carts, cart_lines, order_counters, orders, order_lines, order_events),
`payments.ts` (payment_accounts, payments, payment_webhook_events,
invoice_series, invoices), `promotions.ts` (promotions, coupon_redemptions).
**Every table below is tenant-scoped (DATA PLANE)** — `tenant_id uuid NOT NULL
REFERENCES tenants(id) ON DELETE CASCADE`, FORCE RLS applied automatically by
`rls.ts`. Nothing new goes in `PLATFORM_TABLES`. All ids UUIDv7 via
`$defaultFn(uuidv7)`; all money `bigint` paise via the `paise()` helper +
`currency CHAR(3) DEFAULT 'INR'`; all timestamps `timestamptz`. Enums are
TEXT + `$type<>` union + CHECK via `sqlLiteralList` (the enums.ts pattern —
no PG enums).

### FK-vs-bare-uuid ruling per table (the history-table precedent)

| Table | Kind | Subject refs |
| :-- | :-- | :-- |
| customers, carts, cart_lines | live state | real CASCADE FKs |
| orders, payments, payment_accounts, promotions | long-lived mutable records | tenant FK CASCADE; cross-refs **bare uuid** (an order must survive customer/cart/promotion deletion; snapshots carry the meaning) |
| order_lines | snapshot, dies with order | `order_id` CASCADE FK; `variant_id` **bare uuid nullable** (snapshot is self-contained) |
| order_events, payment_webhook_events, invoices, coupon_redemptions | append-only history | **bare uuid, no FK** to subjects; append-only **by grant** (added to `appendOnly` set in `rls.ts::grantStatements`) |
| invoice_series, order_counters | counters (projection-like) | tenant FK CASCADE; written only inside confirming/creating tx |

## 1.1 customers — lean, guest-first (argued)

Pure guest-only (contact fields on orders alone) was considered and rejected
for exactly two spec needs that require a stable per-buyer key: **per-customer
coupon redemption limits** (blueprint §4.4) and the **first_order promotion
condition** — both are Phase 2 scope. (Phase 3's COD/RTO risk score needs the
same key.) The minimal shape that satisfies them is an upsert-by-phone row
with zero auth machinery:

```sql
CREATE TABLE customers (
  id            UUID PK uuidv7,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_e164    TEXT NOT NULL,           -- the identity key at checkout
  email         TEXT,                    -- last seen; informational
  name          TEXT,                    -- last seen
  first_order_at TIMESTAMPTZ,            -- set once, first confirmed order
  created_at / updated_at TIMESTAMPTZ NOT NULL,
  deleted_at    TIMESTAMPTZ              -- blueprint soft-delete on customer tables
);
UNIQUE INDEX customers_tenant_phone_key (tenant_id, phone_e164);
```

No addresses table: with no login there is no address book to show anyone.
The delivery address is a JSONB snapshot on the order (and transiently on the
cart). RLS: tenant-scoped, standard grants (mutable).

## 1.2 carts + cart_lines — ephemeral live state

Cart identity = the cart row's UUIDv7 id in an httpOnly cookie scoped to the
storefront host (non-enumerable per blueprint §3.1; tenant checked via RLS on
every read, so a cookie replayed against another tenant's host matches zero
rows).

```sql
CREATE TABLE carts (
  id            UUID PK uuidv7,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'active',   -- active|converted (CHECK)
  currency      CHAR(3) NOT NULL DEFAULT 'INR',
  -- checkout-in-progress fields (filled by checkout-start; snapshotted onto the order)
  buyer_name / buyer_phone_e164 / buyer_email   TEXT,
  shipping_address JSONB,     -- {line1,line2,city,state_code,pincode,...}
  coupon_code   TEXT,         -- as typed, uppercased; re-evaluated server-side always
  created_at / updated_at TIMESTAMPTZ NOT NULL
);
INDEX carts_tenant_updated_idx (tenant_id, updated_at);  -- GC sweep

CREATE TABLE cart_lines (
  id            UUID PK uuidv7,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cart_id       UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id    UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity      INT NOT NULL CHECK (quantity > 0 AND quantity <= 100),
  created_at / updated_at TIMESTAMPTZ NOT NULL
);
UNIQUE INDEX cart_lines_cart_variant_key (tenant_id, cart_id, variant_id);
```

Deliberately **no price on cart_lines** — carts always price from the live
catalog at read time (snapshot happens at order creation, blueprint line 365
is about orders). No `abandoned` cart status: an abandoned cart is just a
stale `active` row; a maintenance sweep deletes carts untouched for 30 days.
**No reservation columns anywhere** — holds are `stock_reservations` rows
with `reference {type:'checkout', id: order_id}` (existing machinery, reused
untouched).

## 1.3 order_counters — human order numbers (not gap-free, not invoices)

Order numbers are merchant-facing labels, not statutory documents; gaps are
acceptable, but the allocation still uses the same `UPDATE..RETURNING` recipe
because it is free and race-proof:

```sql
CREATE TABLE order_counters (
  tenant_id    UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  next_number  BIGINT NOT NULL DEFAULT 1001
);
```

Allocated inside the order-creation tx; rendered as `#1042` (display prefix
is a `store_settings` key, not a column). This is NOT `invoice_series` and is
deliberately not merged with it — different guarantees (order numbers allocate
at checkout-start where invoice numbers must never).

## 1.4 orders + order_lines

```sql
CREATE TABLE orders (
  id                 UUID PK uuidv7,
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_number       BIGINT NOT NULL,
  channel            TEXT NOT NULL DEFAULT 'web',        -- CHECK: web|pos|whatsapp|manual
  status             TEXT NOT NULL DEFAULT 'pending_payment',  -- CHECK: ORDER_STATUSES (§3)
  payment_status     TEXT NOT NULL DEFAULT 'pending',    -- CHECK: pending|partially_paid|paid|refund_initiated|refunded
  fulfilment_status  TEXT NOT NULL DEFAULT 'unfulfilled',-- CHECK: unfulfilled|partially_shipped|shipped|delivered|rto  (Phase 3 writes it)

  cart_id            UUID,        -- bare uuid; checkout idempotency anchor
  customer_id        UUID,        -- bare uuid → customers (survives customer soft-delete)

  -- buyer snapshot (guest checkout: the order IS the record)
  buyer_name / buyer_phone_e164 / buyer_email  TEXT NOT NULL / NOT NULL / NULL,
  shipping_address   JSONB NOT NULL,
  place_of_supply    TEXT NOT NULL,      -- GST state code from shipping address
  buyer_gstin        TEXT,               -- optional B2B field at checkout

  -- money (all BIGINT paise) — totals of the per-line snapshots
  currency           CHAR(3) NOT NULL DEFAULT 'INR',
  subtotal_paise     BIGINT NOT NULL,    -- pre-discount, tax-inclusive line sum
  discount_paise     BIGINT NOT NULL DEFAULT 0,
  shipping_paise     BIGINT NOT NULL DEFAULT 0,   -- a taxable line too, see order_lines.kind
  tax_paise          BIGINT NOT NULL DEFAULT 0,   -- sum of line tax (informational; lines are truth)
  total_paise        BIGINT NOT NULL,
  amount_paid_paise  BIGINT NOT NULL DEFAULT 0,
  cod_due_paise      BIGINT NOT NULL DEFAULT 0,
  awb_cod_synced_at  TIMESTAMPTZ,        -- Phase 3 writes; modeled now (blueprint §4.3)

  promotion_id       UUID,               -- bare uuid; NULL when no coupon
  coupon_code_snapshot TEXT,             -- what the buyer typed, for display forever

  payment_provider   TEXT,               -- CHECK: razorpay|mock; set at payment-start
  gateway_order_ref  TEXT,               -- gateway's order id (razorpay order_xxx)

  placed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at / cancelled_at  TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,        -- pending_payment TTL; read-side filter like holds
  created_at / updated_at TIMESTAMPTZ NOT NULL
);
UNIQUE INDEX orders_tenant_number_key (tenant_id, order_number);
UNIQUE INDEX orders_tenant_cart_key (tenant_id, cart_id) WHERE cart_id IS NOT NULL;  -- one order per cart = checkout idempotency
UNIQUE INDEX orders_gateway_ref_key (tenant_id, gateway_order_ref) WHERE gateway_order_ref IS NOT NULL;  -- webhook lookup
INDEX orders_tenant_status_idx (tenant_id, status, placed_at);
INDEX orders_customer_idx (tenant_id, customer_id);

CREATE TABLE order_lines (
  id                UUID PK uuidv7,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id          UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL DEFAULT 'item',  -- CHECK: item|shipping  (shipping is a taxable LINE, §4.1)
  variant_id        UUID,                          -- bare uuid, nullable; snapshot is authoritative
  title_snapshot    TEXT NOT NULL,
  sku_snapshot      TEXT NOT NULL DEFAULT '',      -- '' for shipping line
  hsn_snapshot      TEXT,
  quantity          INT NOT NULL CHECK (quantity > 0),
  unit_price_paise  BIGINT NOT NULL,               -- as displayed (tax-inclusive default)
  discount_paise    BIGINT NOT NULL DEFAULT 0,     -- this line's allocated share, pre-tax
  taxable_paise     BIGINT NOT NULL,               -- post-discount, tax-EXCLUSIVE base
  tax_rate_bps      INT NOT NULL,
  cgst_paise / sgst_paise / igst_paise  BIGINT NOT NULL DEFAULT 0,  -- stored split (never recomputed)
  tax_paise         BIGINT NOT NULL,               -- = cgst+sgst+igst
  total_paise       BIGINT NOT NULL,               -- what the buyer pays for this line
  position          INT NOT NULL DEFAULT 0
);
INDEX order_lines_order_idx (tenant_id, order_id);
```

The stored CGST/SGST/IGST split is a snapshot decision: the intra-state
half-split has a rounding subtlety (r/2 twice ≠ r once at paise precision),
so the values computed at confirmation are stored and never re-derived.

## 1.5 order_events — append-only history (audit_log precedent)

```sql
CREATE TABLE order_events (
  id             UUID PK uuidv7,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id       UUID NOT NULL,              -- bare uuid, no FK
  event          TEXT NOT NULL,              -- 'order.confirmed', 'order.cancelled', 'promotion.overredeemed', ...
  from_status / to_status  TEXT,             -- NULL for non-transition events
  actor_type     TEXT NOT NULL,              -- reuses ACTOR_TYPES: staff|customer|system
  actor_user_id  UUID REFERENCES users(id),  -- users is control-plane; FK fine (audit_log precedent)
  data           JSONB,                      -- event payload snapshot (amounts, gateway ids)
  request_id     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INDEX order_events_order_idx (tenant_id, order_id, created_at);
```

In the `appendOnly` grant set. This is both the merchant-visible order
timeline and the source row for queue emission (§3): the domain event is
enqueued after the tx that inserted its order_events row commits.

## 1.6 payment_accounts, payments, payment_webhook_events, invoice_series, invoices

`payment_accounts` mirrors `carrier_accounts` column-for-column where it can
(same envelope crypto, same fingerprint-only console display):

```sql
CREATE TABLE payment_accounts (
  id                UUID PK uuidv7,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_code     TEXT NOT NULL,        -- CHECK: PAYMENT_PROVIDER_CODES = razorpay|mock
  label             TEXT NOT NULL DEFAULT 'Default',
  public_key_id     TEXT NOT NULL,        -- razorpay key_id: public by design (browser checkout needs it)
  sealed_credentials TEXT NOT NULL,       -- envelope: {key_secret, webhook_secret}; AAD-bound (tenant, provider)
  credential_fingerprint TEXT NOT NULL,
  is_enabled        BOOLEAN NOT NULL DEFAULT false,
  last_verified_at  TIMESTAMPTZ, last_error TEXT,
  created_at / updated_at TIMESTAMPTZ NOT NULL, updated_by_user_id UUID REFERENCES users(id)
);
UNIQUE INDEX payment_accounts_tenant_provider_label_key (tenant_id, provider_code, label);
UNIQUE INDEX payment_accounts_one_enabled_key (tenant_id) WHERE is_enabled;  -- exactly one live gateway in Phase 2

CREATE TABLE payments (        -- one row per gateway payment attempt; mutable status
  id                 UUID PK uuidv7,
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id           UUID NOT NULL,       -- bare uuid: financial record outlives everything but the tenant
  payment_account_id UUID NOT NULL,       -- bare uuid (account may be deleted/rotated)
  provider_code      TEXT NOT NULL,
  purpose            TEXT NOT NULL DEFAULT 'sale',  -- CHECK: sale|refund
  status             TEXT NOT NULL DEFAULT 'created',-- CHECK: created|authorized|captured|failed|refund_initiated|refunded
  amount_paise       BIGINT NOT NULL, currency CHAR(3) NOT NULL DEFAULT 'INR',
  gateway_order_id   TEXT,                -- order_xxx
  gateway_payment_id TEXT,                -- pay_xxx (set by webhook)
  gateway_refund_id  TEXT,                -- rfnd_xxx
  method             TEXT,                -- upi|card|netbanking... as reported
  error_code / error_description TEXT,
  captured_at / refunded_at TIMESTAMPTZ,
  created_at / updated_at TIMESTAMPTZ NOT NULL
);
UNIQUE INDEX payments_gateway_payment_key (tenant_id, gateway_payment_id) WHERE gateway_payment_id IS NOT NULL;
INDEX payments_order_idx (tenant_id, order_id);

CREATE TABLE payment_webhook_events (    -- append-only raw log; THE idempotency gate
  id               UUID PK uuidv7,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_code    TEXT NOT NULL,
  gateway_event_id TEXT NOT NULL,        -- x-razorpay-event-id; mock supplies its own
  event_type       TEXT NOT NULL,        -- payment.captured, refund.processed, ...
  order_id / payment_id  UUID,           -- bare uuids, resolved at receipt, nullable
  raw_payload      JSONB NOT NULL,       -- stored AFTER HMAC verification only
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
UNIQUE INDEX pwe_gateway_event_key (tenant_id, provider_code, gateway_event_id);
```

`payment_webhook_events` is append-only by grant, so it carries **no
processed_at**: the row is inserted in its own small committed tx (dedupe +
evidence), then processing runs as a second tx that is idempotent by
construction (payment/order status transitions no-op on replay). 2xx is
returned only after the processing tx commits; a processing failure returns
5xx and rides the gateway's redelivery. (Flow detail in §2.4.)

`invoice_series` is verbatim blueprint (367–393) plus hygiene columns:

```sql
CREATE TABLE invoice_series (
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  series_code    TEXT NOT NULL,           -- 'INV' (tax invoice), 'BOS' (bill of supply)
  financial_year TEXT NOT NULL,           -- '2025-26' (Indian FY, Asia/Kolkata boundary)
  prefix         TEXT NOT NULL,
  next_number    INT  NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, series_code, financial_year)
);
-- rows created lazily (INSERT .. ON CONFLICT DO NOTHING then UPDATE..RETURNING)
-- inside the confirming tx; get-or-create matches ensureDefaultLocation's shape.

CREATE TABLE invoices (                   -- append-only: an issued document never mutates
  id             UUID PK uuidv7,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id       UUID NOT NULL,           -- bare uuid
  doc_type       TEXT NOT NULL,           -- CHECK: tax_invoice|bill_of_supply  (credit_note joins the union in Phase 3)
  series_code / financial_year  TEXT NOT NULL,
  number         INT NOT NULL,
  invoice_number TEXT NOT NULL,           -- rendered: '{prefix}{FY}/{number padded}' — display string frozen at issue
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  seller         JSONB NOT NULL,          -- {legal_name, gstin, address, state_code, tax_registration_type}
  buyer          JSONB NOT NULL,          -- {name, phone, email, gstin?, shipping_address}
  place_of_supply TEXT NOT NULL,
  lines          JSONB NOT NULL,          -- full order_lines snapshot incl. tax split — the render document
  subtotal_paise / discount_paise / taxable_paise /
  cgst_paise / sgst_paise / igst_paise / total_paise  BIGINT NOT NULL,
  currency       CHAR(3) NOT NULL DEFAULT 'INR',
  irn            TEXT,                    -- IRP registration number  ← room for e-invoicing,
  irn_qr         TEXT,                    -- signed QR payload           written later by a worker,
  irn_registered_at TIMESTAMPTZ           --                             no schema change needed
);
UNIQUE INDEX invoices_series_number_key (tenant_id, series_code, financial_year, number);
UNIQUE INDEX invoices_order_doc_key (tenant_id, order_id, doc_type);   -- one tax invoice per order
```

Append-only + fully self-contained `lines`/`seller`/`buyer` JSONB means the
render layer needs exactly one row and zero joins — the snapshot rule taken
to its conclusion. (IRN columns are nullable UPDATEs — exception to the
grant? No: IRN lands in Phase 3; when it does, the write happens via a
narrow `UPDATE invoices SET irn... WHERE irn IS NULL` grant added THEN. For
Phase 2 the table stays strictly SELECT+INSERT.)

## 1.7 promotions + coupon_redemptions

```sql
CREATE TABLE promotions (
  id             UUID PK uuidv7,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,           -- uppercased at write; coupon entry key
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft',  -- CHECK: draft|active|archived
  starts_at / ends_at  TIMESTAMPTZ,       -- NULL = unbounded
  conditions     JSONB NOT NULL DEFAULT '[]',    -- Condition[] (blueprint §4.4, zod-validated at write)
  effects        JSONB NOT NULL DEFAULT '[]',    -- Effect[]
  usage_limit_total        INT,           -- NULL = unlimited
  usage_limit_per_customer INT,
  created_at / updated_at TIMESTAMPTZ NOT NULL, updated_by_user_id UUID REFERENCES users(id)
);
UNIQUE INDEX promotions_tenant_code_key (tenant_id, code);

CREATE TABLE coupon_redemptions (        -- append-only; the LIMIT ENFORCER
  id            UUID PK uuidv7,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  promotion_id  UUID NOT NULL,           -- bare uuid
  order_id      UUID NOT NULL,           -- bare uuid
  customer_id   UUID,                    -- bare uuid (customers row exists at checkout)
  slot          INT NOT NULL,            -- 0-based position in the total-limit window
  customer_slot INT NOT NULL DEFAULT 0,  -- 0-based position in the per-customer window
  discount_paise BIGINT NOT NULL,        -- what this redemption was worth (reporting)
  redeemed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
UNIQUE INDEX cr_promo_slot_key (tenant_id, promotion_id, slot);
UNIQUE INDEX cr_promo_customer_slot_key (tenant_id, promotion_id, customer_id, customer_slot)
  WHERE customer_id IS NOT NULL;
UNIQUE INDEX cr_promo_order_key (tenant_id, promotion_id, order_id);   -- one redemption per order
```

**Slot mechanics** (unique-constraint enforcement, per the brief, never a
counter): inside the confirming tx, lock the promotion row `FOR UPDATE`
(serializes slot computation), `slot = COUNT(*)` for the promotion,
`customer_slot = COUNT(*)` for (promotion, customer); refuse with
`coupon_exhausted` (422) when `slot >= usage_limit_total` or
`customer_slot >= usage_limit_per_customer`; INSERT. A concurrent insert that
slips past the lock collides on the unique index → 23505 → mapped to 409
retry. The unique constraint is the guard; the lock just makes it quiet.
Timing (claim at confirmation, validated at checkout-start) argued in §2.4.

## 1.8 Enum additions (packages/db/src/schema/enums.ts)

```ts
export const ORDER_STATUSES = ["pending_payment","confirmed","processing",
  "ready_to_ship","shipped","out_for_delivery","delivered","rto_initiated",
  "rto_delivered","return_requested","return_picked","refunded","cancelled",
  "abandoned"] as const;               // FULL blueprint set now — one migration, transitions gate usage (§3)
export const ORDER_PAYMENT_STATUSES = ["pending","partially_paid","paid","refund_initiated","refunded"] as const;
export const ORDER_FULFILMENT_STATUSES = ["unfulfilled","partially_shipped","shipped","delivered","rto"] as const;
export const ORDER_CHANNELS = ["web","pos","whatsapp","manual"] as const;
export const CART_STATUSES = ["active","converted"] as const;
export const PAYMENT_PROVIDER_CODES = ["razorpay","mock"] as const;   // mock = dev/CI, fail-closed gate
export const PAYMENT_STATUSES = ["created","authorized","captured","failed","refund_initiated","refunded"] as const;
export const PAYMENT_PURPOSES = ["sale","refund"] as const;
export const INVOICE_DOC_TYPES = ["tax_invoice","bill_of_supply"] as const;
export const PROMOTION_STATUSES = ["draft","active","archived"] as const;
export const ORDER_LINE_KINDS = ["item","shipping"] as const;
// EXTENDED (migration re-creates the CHECK):
export const STOCK_MOVEMENT_REASONS = ["opening_balance","adjustment","sale",
  "cancellation_restock"] as const;    // +1 member; RTO reasons arrive Phase 3 per followups doc
```

## 1.9 Serviceability & gateway/shipping config — NO new tables

- **Pincode serviceability** reuses `serviceability_cache` (already modeled
  per (carrier, lane, weight-slab, payment-mode) with TTL) behind a
  `checkServiceability(tenantId, {toPincode, weightGrams, paymentMode})`
  server function that consults enabled carrier adapters through the existing
  registry, cache-first. Merchants without a carrier account yet get a
  tenant-level policy from `store_settings` key `shipping.pincode_policy`:
  `{"mode":"all"} | {"mode":"carrier"} | {"mode":"list","allowedPrefixes":[...]}`
  (default `all` so checkout works day one).
- **Shipping fee**: `store_settings` keys `shipping.flat_fee_paise`,
  `shipping.free_above_paise` (blueprint §3.2 names these as settings).
- **Partial payment policy**: `store_settings` keys `payments.advance_pct`
  (bps), `payments.min_advance_paise`, `payments.cod_enabled`.
- **Order number prefix / invoice prefix defaults**: `store_settings`
  `orders.number_prefix`, `invoicing.prefix` (seeds new `invoice_series`
  rows).

## 1.10 rls.ts changes

`appendOnly` set gains: `order_events`, `payment_webhook_events`, `invoices`,
`coupon_redemptions`. `PLATFORM_TABLES` unchanged (nothing control-plane).
Everything else is automatic.

---

# 2. Flows (transaction boundaries marked `[TX]`)

Every `[TX]` is one `withTenant(tenantId, tx => ...)`. Everything outside a
`[TX]` marker is non-transactional (cache purge, queue enqueue, HTTP).

## 2.1 Add to cart / update line (storefront, no session actor)

1. Resolve tenant from Host (existing storefront resolver). Read `cart_id`
   cookie; zod-parse body `{variantId, quantity}`.
2. `[TX]` get-or-create cart; **visibility SELECT** on variant (active, not
   deleted, product active); read `getAvailability(tx,[variantId])`; refuse
   `insufficient_stock` if requested > available (tracked variants); upsert
   cart_line (`ON CONFLICT (tenant_id, cart_id, variant_id) DO UPDATE`);
   touch `carts.updated_at`.
3. Set cookie if new. Return cart totals (priced live; promotions evaluated
   read-only if `coupon_code` present). **No holds at cart stage** — holds
   begin at checkout-start; cart-stage availability is advisory.

## 2.2 Checkout-start (storefront) — the holds boundary

`POST /api/checkout` with `{buyer, shippingAddress, couponCode?, paymentMode}`.

1. Zod-parse; cheap validation (pincode `^[1-9][0-9]{5}$`, E.164 phone).
2. **Serviceability check** (non-tx read): `checkServiceability(...)` against
   cache/policy → refuse `pincode_unserviceable` (422).
3. `[TX-A]` price the cart: visibility SELECT all cart variants (live join —
   the LAST live read); load promotion by code (`active`, in window) +
   advisory limit check (counts redemptions **plus** live pending_payment
   orders carrying this promotion_id with `expires_at > now()` — closes the
   flash-sale window, see §2.4g); evaluate promotions (pure); compute GST
   (pure); compute advance/COD split (pure); **allocate order_number**
   (`UPDATE order_counters .. RETURNING`, get-or-create row first); upsert
   `customers` by phone; INSERT `orders` (status `pending_payment`,
   `expires_at = now() + 25 min`, `cart_id` set) + `order_lines` (full
   snapshot incl. shipping line + stored tax split) + `order_events`
   (`order.placed`, actor customer); mark cart `converted`.
   - Idempotency: `orders_tenant_cart_key` unique on cart_id — a double-POST
     replays the winner (23505 → fetch existing pending order, return it).
4. `holdStock({tenantId}, {reference: {type: "checkout", id: orderId}, lines})`
   — **its own `[TX-B]`, the existing entry point, unmodified.** On
   `insufficient_stock`: `[TX-C]` mark order `cancelled` (event
   `order.hold_failed`), return 422 with per-line issues (buyer adjusts the
   cart; the order row is cheap to abandon — no invoice number, no redemption
   was touched). Ordering note: order-first-then-hold means a crash between
   TX-A and TX-B leaves a pending order with no hold — harmless: confirmation
   consumes from ORDER lines (holds are best-effort protection; the on_hand
   CHECK is the real guard) and the expiry job reaps it.
5. Payment-start (same request): decrypt `payment_accounts` credentials
   (envelope, AAD (tenant, provider)); adapter `createGatewayOrder(amount =
   advance or total)` — **the one outbound HTTP call on this path** (Razorpay
   order creation must be synchronous, the buyer is waiting; mock returns
   instantly). `[TX-D]` write `payments` row (`created`) +
   `orders.gateway_order_ref` / `payment_provider`.
6. Return `{orderId, gatewayOrderId, publicKeyId, amountPaise}` for Razorpay
   JS checkout (mock: an auto-confirm button in dev). After all commits,
   enqueue delayed job `checkout.expire` (orders queue, delay 30 min,
   payload `{tenantId, orderId}`).

Payment retry: buyer re-POSTs → idempotent replay path re-runs `holdStock`
(replace semantics refresh the same reference) and extends `expires_at`.

## 2.3 Payment drivers (BYOG)

Adapter contract (types in `@platform/core/payments` pure barrel;
implementations in `@platform/integrations`):

```ts
interface PaymentGatewayAdapter {
  readonly provider: PaymentProviderCode;
  createGatewayOrder(creds, args: {amountPaise: number; currency: string; receipt: string}): Promise<{gatewayOrderId: string}>;
  verifyWebhook(creds, args: {rawBody: string; signature: string}): boolean;   // HMAC-SHA256, timingSafeEqual
  parseWebhook(rawBody: string): GatewayEvent;   // {eventId, type, gatewayOrderId, gatewayPaymentId?, amountPaise, method?, error?}
  refund(creds, args: {gatewayPaymentId: string; amountPaise: number}): Promise<{gatewayRefundId: string}>;
}
```

- `razorpay.ts`: real HTTPS; webhook signature `HMAC_SHA256(webhook_secret,
  rawBody)` vs `x-razorpay-signature`; event id from `x-razorpay-event-id`.
- `mock.ts`: in-process; fabricates ids; exports `mockWebhookBody(...)` +
  signer so integration tests drive the REAL webhook route end to end.
  Registry gate copies the fake-carrier precedent exactly: **mock refuses in
  production and fails closed on unset NODE_ENV.**

## 2.4 Webhook confirm (storefront `/api/payments/webhook`) — the money tx

1. Resolve tenant from Host. Read raw body (bounded 256 KiB). Load the
   enabled `payment_account` (+ decrypt); `verifyWebhook` **before any domain
   work**; invalid → 401, nothing stored.
2. `[TX-1]` INSERT `payment_webhook_events` (raw payload, gateway event id)
   `ON CONFLICT DO NOTHING`. Commit. Evidence + dedupe row survives even if
   processing fails; append-only, so no processed flag (§1.6) — processing
   idempotence lives in the state machine, retry rides gateway redelivery
   (5xx on processing failure).
3. `[TX-2]` — **the confirmation transaction** (for `payment.captured`):
   - a. SELECT order by `gateway_order_ref` `FOR UPDATE`; SELECT payment row.
   - b. Idempotence gate: payment already `captured` → return replay (200).
   - c. Amount check vs expected (advance or total); mismatch → payment
     `failed` + event `payment.amount_mismatch`, no state advance (200,
     merchant-visible).
   - d. `payments` → `captured` (+`gateway_payment_id`, method,
     `captured_at`); `orders.amount_paid_paise += amount`;
     `payment_status = paid | partially_paid` (COD balance outstanding).
   - e. State transition `pending_payment → confirmed` via the transition
     table (§3); sets `confirmed_at`, clears `expires_at`.
   - f. **`consumeStockWithin(tx, ctx, {reference: {type: "checkout", id:
     orderId}, lines: ORDER lines})`** — the one small refactor of the
     existing inventory module (§4): order is the authority, hold rows only
     shield. Failure handling per the followups contract:
     `insufficient_stock` (unit stolen after hold lapse) → whole `[TX-2]`
     rolls back → order NOT confirmed → handler runs a small `[TX-3]`
     marking the order `cancelled` (event `order.oversold`) and enqueues an
     auto-refund job; `stock_held` cannot fire on this path (consume deletes
     its own hold row first — documented invariant, asserted in tests).
   - g. Coupon redemption claim (if `promotion_id`): promotion row
     `FOR UPDATE`, slot computation, INSERT `coupon_redemptions` (§1.7).
     Exhausted at this instant (window ≈ 0 given the checkout-start advisory
     count): confirm anyway, skip the insert, write
     `order_events promotion.overredeemed` — refusing a captured payment
     over a coupon is strictly worse; the merchant sees the flag.
   - h. **Invoice allocation, same tx** (locked decision): get-or-create
     `invoice_series` row (`INV` for regular tenants, `BOS` for
     unregistered/composition; FY via `financialYearOf(now, "Asia/Kolkata")`);
     `UPDATE .. RETURNING next_number - 1`; INSERT `invoices` with the full
     JSONB snapshot built from the order rows in hand.
   - i. `order_events` (`order.confirmed`, actor system) + `recordAudit`.
4. After commit: enqueue `order.confirmed` domain event;
   `purgeStorefrontCache` for consumed products (ids returned by
   `consumeStockWithin`), fail-soft. Respond 200.

Other event types: `refund.processed` → `[TX]` payment `refund_initiated →
refunded`, order `payment_status = refunded`, event `order.refunded`;
`payment.failed` → `[TX]` payment `failed`, event `payment.failed`, order
stays `pending_payment` (buyer may retry until expiry).

## 2.5 Abandoned expiry

Worker job `checkout.expire` (delayed job from §2.2.6; the existing daily
reservation GC remains backstop hygiene):

1. `[TX]` SELECT order: not `pending_payment` → done (paid or cancelled
   meanwhile). `expires_at > now()` (extended by retry) → re-enqueue at the
   new expiry. Else transition `pending_payment → abandoned` (+event).
2. `releaseStock({tenantId}, {type: "checkout", id: orderId})` — own `[TX]`,
   existing entry point, idempotent.
3. Enqueue `order.abandoned` (Phase 4 messaging will subscribe; the Phase 2
   consumer logs).

Read-side rule preserved: holds already stop counting at `expires_at`
regardless of this job — the job is bookkeeping, never correctness.

## 2.6 Cancel + full refund (pre-shipment only — Phase 2 scope)

Console `POST /api/orders/[id]/cancel` (permission `orders:cancel`):

1. `[TX]` SELECT order `FOR UPDATE`; transition table permits `confirmed →
   cancelled` and `processing → cancelled` only (anything shipped → 422
   `invalid_transition`). Restock each tracked line via `restockWithin(tx,
   ...)`: `+quantity` movement, reason `cancellation_restock`, reference
   `{type: "order", id}` (same-tx ledger + projection). Set `cancelled_at`,
   `order_events` (`order.cancelled`, actor staff), `recordAudit`.
2. After commit: if `amount_paid_paise > 0`, enqueue `payments.refund` job
   `{tenantId, orderId, paymentId, amountPaise}` (full refund only). The
   worker calls adapter `refund(...)` under backoff/circuit-breaker
   (blueprint §5.4) and `[TX]` marks the payment `refund_initiated`;
   terminal `refunded` arrives via webhook (§2.4). Enqueue `order.cancelled`
   domain event; purge cache for restocked products.

**Phase 3 stubs that exist:** `invoices.doc_type` union ready for
`credit_note`; RTO/return states present in the enum + transition table but
unreachable (no route or webhook writes them); `awb_cod_synced_at` dormant;
`order_events` vocabulary open. Nothing else is pre-built.

---

# 3. Order state machine + domain events

## 3.1 States and transitions

The FULL blueprint state set ships in one migration (§1.8) so Phase 3 adds no
enum migration; the transition table is the gate that keeps Phase-3 states
unreachable. It is **pure data** in `@platform/core/orders` (client-safe,
exhaustively unit-tested):

```ts
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ["confirmed", "abandoned", "cancelled"], // cancelled = hold_failed / oversold paths
  confirmed:       ["processing", "cancelled"],
  processing:      ["ready_to_ship", "cancelled"],
  ready_to_ship:   ["shipped"],                             // Phase 3 writes from here down
  shipped:         ["out_for_delivery", "rto_initiated"],
  out_for_delivery:["delivered", "rto_initiated"],
  rto_initiated:   ["rto_delivered"],
  delivered:       ["return_requested"],
  return_requested:["return_picked"],
  return_picked:   ["refunded"],
  abandoned: [], cancelled: [], refunded: [], rto_delivered: [],  // terminal
};
export function canTransition(from: OrderStatus, to: OrderStatus): boolean;
```

**Where enforced:** one write door, `transitionOrder(tx, ctx, order, to,
event)` in `@platform/core/orders/server` — called by checkout confirm,
cancel, expiry, and the console's manual transition route. It (1) checks
`canTransition` and throws `AppError code:"invalid_transition"` (422) on
refusal; (2) UPDATEs `orders.status` **with `WHERE status = from`** as the
lost-update guard (0 rows → 409 `concurrent_modification`); (3) INSERTs the
`order_events` row; (4) returns the event descriptor for post-commit
enqueue. No route mutates `orders.status` directly; the CHECK constraint on
the column stops garbage, the door stops illegal moves.

Phase 2 reachable subset: `pending_payment`, `confirmed`, `processing`
(merchant accept), `ready_to_ship` (merchant packs — no AWB yet, Phase 3
wires couriers), `cancelled`, `abandoned`. Console manual moves allowed:
`confirmed→processing`, `processing→ready_to_ship`, and the cancel route.

## 3.2 Domain events

**Queue:** one new BullMQ queue `orders` (name added to
`QUEUE_NAMES` in `packages/core/src/queues.ts`), plus `payments` for
outbound gateway work (refunds). Job name = event type.

**Payload shape (`TenantJob` discipline — tenantId mandatory):**

```ts
type OrderDomainEvent = {
  tenantId: string;
  orderId: string;
  event: "order.placed" | "order.confirmed" | "order.cancelled"
       | "order.abandoned" | "order.refunded" | "order.oversold";
  occurredAt: string;          // ISO, from the order_events row
  orderEventId: string;        // provenance link to the order_events row
  requestId?: string | null;
  data?: Record<string, unknown>;  // small: amounts, order_number — consumers re-read the DB for truth
};
```

**Emission:** always AFTER the writing transaction commits (brief §2.11),
from the route/domain layer via a tiny `enqueueOrderEvent(event)` helper in
`@platform/core/orders/server` (BullMQ producer using the shared redis).
The `order_events` table row is the durable record; the queue message is
delivery. A crash between commit and enqueue loses only a notification, never
state — acceptable for Phase 2 consumers (log/analytics); if Phase 4
messaging needs at-least-once, an outbox sweep over `order_events` can be
added without schema change (the table already has everything).

**Consumption (`apps/worker`):**
- `jobs/order-events.ts` — Worker on `orders` queue. Phase 2 handlers:
  `checkout.expire` (the delayed expiry job, §2.5) and a structured-log
  handler for all `order.*` events (`{tenantId, orderId, event}`) that is
  the seam where messaging/analytics subscribe later. Handler's first act:
  `withTenant(job.data.tenantId, ...)`.
- `jobs/gateway-refund.ts` — Worker on `payments` queue: decrypt creds, call
  adapter `refund`, mark `refund_initiated`; retries via `defaultJobOptions`
  (exponential backoff, retained failures = dead-letter visibility).
- Registration follows the recipe: queue in `apps/worker/src/queues.ts`,
  Worker in `index.ts` **below** `import "./env"`.

---

# 4. Module map

## New files (responsibility, one line each)

**packages/db/src/schema/**
- `commerce.ts` — customers, carts, cart_lines, order_counters, orders, order_lines, order_events.
- `payments.ts` — payment_accounts, payments, payment_webhook_events, invoice_series, invoices.
- `promotions.ts` — promotions, coupon_redemptions.

**packages/core/src/** (every domain gets the pure/server barrel split;
`package.json#exports` gains both entries per domain)
- `tax/index.ts` — PURE: GST computation, financial-year helper, money rounding/allocation (§5.1).
- `orders/index.ts` — PURE: statuses, transition table, event names/types, order-number formatting.
- `orders/server.ts` — transitionOrder write door, enqueueOrderEvent, console order queries (list/detail), manual-transition + cancel entry points.
- `cart/index.ts` — PURE: cart totals type, line clamp constants.
- `cart/server.ts` — get-or-create cart, upsertLine, removeLine, getCartView (priced live + availability).
- `checkout/index.ts` — PURE: checkout payload types, pincode regex, advance/COD math re-export.
- `checkout/server.ts` — startCheckout (§2.2), confirmFromWebhookEvent (§2.4 TX-2), expireCheckout (§2.5), the ONLY module allowed to import cart+orders+payments+promotions+invoices+inventory servers (orchestrator).
- `payments/index.ts` — PURE: provider codes, adapter interface types, GatewayEvent type, computeAdvanceSplit.
- `payments/server.ts` — payment_accounts CRUD (envelope seal/unseal, fingerprint), getEnabledAccount, recordWebhookEvent (TX-1), payment row writes.
- `promotions/index.ts` — PURE: Condition/Effect types + zod schemas, evaluatePromotions, discount allocation.
- `promotions/server.ts` — promotions CRUD, loadActivePromotion, claimRedemption(tx, ...) in-tx helper, advisory limit count.
- `invoices/index.ts` — PURE: doc types, financialYearOf, formatInvoiceNumber, InvoiceDoc type.
- `invoices/server.ts` — allocateInvoiceNumber(tx, ...), createInvoice(tx, ...) (both in-tx, called only by checkout/server), getInvoiceForRender.
- `serviceability/index.ts` — PURE: pincode validation, policy types.
- `serviceability/server.ts` — checkServiceability (store_settings policy + serviceability_cache + carrier registry, cache-first).
- `customers/server.ts` — upsertCustomerByPhone(tx, ...), markFirstOrder(tx, ...) (tiny; no pure barrel needed beyond types in orders).

**packages/integrations/src/payments/**
- `types.ts` — re-export of the core adapter contract (mirror of carriers).
- `razorpay.ts` — real driver (HTTPS order create, HMAC verify, refund).
- `mock.ts` — dev/CI driver + webhook-body fabricator for tests.
- `registry.ts` — provider→adapter map with the fail-closed NODE_ENV gate.

**apps/storefront/src/**
- `app/cart/page.tsx` — cart page (force-dynamic, uncached live read).
- `app/checkout/page.tsx` — address/contact/coupon form + payment hand-off (client component for gateway JS).
- `app/order/[id]/page.tsx` — guest order status page, gated by HMAC token in the URL query (issued at checkout; no login).
- `app/api/cart/route.ts` — GET view / POST upsert line / DELETE line.
- `app/api/checkout/route.ts` — POST startCheckout.
- `app/api/checkout/serviceability/route.ts` — POST pincode precheck (PDP/cart widget).
- `app/api/payments/webhook/route.ts` — the webhook door (§2.4).
- `lib/cart-cookie.ts` — httpOnly cookie read/write helper.
- `lib/order-token.ts` — HMAC sign/verify for the guest order URL.

**apps/console/src/**
- `app/(dashboard)/orders/page.tsx` + `orders/[id]/page.tsx` — list (status filter) and detail (lines, payments, timeline from order_events, action buttons).
- `app/orders/[id]/invoice/page.tsx` — print-CSS invoice render (§7).
- `app/(dashboard)/promotions/page.tsx` + `promotions/[id]/page.tsx` — CRUD UI over conditions/effects.
- `app/(dashboard)/settings/payments/page.tsx` — gateway credential form (fingerprint display only).
- `app/api/orders/[id]/transition/route.ts`, `app/api/orders/[id]/cancel/route.ts`, `app/api/promotions/route.ts` (+`[id]`), `app/api/settings/payments/route.ts` — thin zod + `handleCatalogWrite`-style handlers.

**apps/worker/src/jobs/**
- `order-events.ts` — orders-queue Worker (checkout.expire + event log seam).
- `gateway-refund.ts` — payments-queue Worker (adapter refund call).

## Existing files changed (and how little)

| File | Change |
| :-- | :-- |
| `packages/db/src/schema/enums.ts` | add the §1.8 const arrays; extend `STOCK_MOVEMENT_REASONS` by one member |
| `packages/db/src/schema/index.ts` | export three new schema files |
| `packages/db/src/rls.ts` | 4 additions to `appendOnly`; nothing else |
| `packages/core/src/inventory/server.ts` | **extract-and-export** `consumeStockWithin(tx, ctx, input)` and add `restockWithin(tx, ctx, line, reference)` (thin wrapper over the existing private `applyMovement`); public wrappers keep their exact signatures/behavior; reword `StockHeldError.publicMessage` for the buyer path (flagged in PHASE2_FOLLOWUPS) |
| `packages/core/src/queues.ts` | +`orders`, +`payments` queue names |
| `packages/core/package.json` | +exports for the new barrels |
| `packages/core/src/identity/permissions.ts` | +`promotions:read/write`, +`payments:write` (orders:* already exist); role grants |
| `apps/worker/src/queues.ts` / `index.ts` | register 2 queues / 2 Workers below `import "./env"` |
| console nav component | +Orders, +Promotions, +Payments-settings links |

No existing behavior changes anywhere: the inventory refactor is
extract-method with the public API frozen (existing reservation integration
tests must pass untouched — that is the regression gate).

---

# 5. Pure-function signatures + edge cases

All in pure barrels: no DB, no env, 100% branch coverage expected on
promotions and tax.

## 5.1 GST engine (`@platform/core/tax`)

```ts
type TaxableLine = {
  lineId: string;
  taxablePaise: number;      // post-discount; inclusive OR exclusive per flag
  taxRateBps: number;        // 0 | 500 | 1200 | 1800 | 2800 ...
};
type TaxContext = {
  sellerStateCode: string;         // tenants.origin_state_code
  placeOfSupplyStateCode: string;  // delivery address state
  registrationType: TaxRegistrationType;   // unregistered|regular|composition
  inclusive: boolean;              // default true (locked)
};
type LineTax = {
  lineId: string;
  taxableExclusivePaise: number;   // base after inclusive extraction
  cgstPaise: number; sgstPaise: number; igstPaise: number; taxPaise: number;
};

export function computeLineTaxes(lines: TaxableLine[], ctx: TaxContext): LineTax[];
export function financialYearOf(at: Date, tz?: "Asia/Kolkata"): string;  // "2025-26"
export function docTypeFor(reg: TaxRegistrationType): "tax_invoice" | "bill_of_supply";
export function roundHalfUp(value: number, /* already integer-paise math helpers */): number;
export function allocateProportionally(totalPaise: number, weights: number[]): number[];
  // largest-remainder allocation; sum(out) === totalPaise exactly; used for
  // spreading an order-level discount across lines pre-tax
```

Rules encoded: unregistered/composition → all zeros (Bill of Supply);
intra-state (seller === PoS) → CGST + SGST each `round(tax/2)` with the
**odd-paise rule**: cgst = HALF_UP(tax/2), sgst = tax − cgst (sum invariant);
inter-state → IGST full; inclusive extraction `tax = price × r / (1 + r)`
rounded HALF_UP **per line then summed** — never sum-then-round.

Edge cases pinned by tests: rate 0 (exempt line); odd-paise intra split
(tax = 1 paise → cgst 1, sgst 0 keeps the sum; document the chosen side);
inclusive extraction of ₹999 @18% (15,239 paise tax, the classic);
quantity multiplication before extraction (line total, not unit, is the
base); discount to zero (taxable 0 → tax 0); shipping line at principal
supply's rate (highest-value item line's rate — the composite-supply rule,
computed by the caller and passed as the shipping line's rate);
composition tenant with buyer_gstin present (still no tax); same-state
buyer with different-case/whitespace state codes (normalize first);
maximum-money lines (no float drift — all integer math);
exclusive mode add-on (`tax = base × r`, HALF_UP).

## 5.2 Partial payment (`@platform/core/payments` pure)

```ts
type AdvancePolicy = {
  codEnabled: boolean;
  advanceBps: number | null;        // e.g. 2000 = 20%; null = full prepaid only
  minAdvancePaise: number;          // floor
};
export function computeAdvanceSplit(totalPaise: number, policy: AdvancePolicy,
  chosenMode: "prepaid" | "cod_advance"):
  { advancePaise: number; codDuePaise: number };
```

Edge cases: cod disabled but mode cod_advance → refuse (`invalid_payload`);
advance > total after min-floor → clamp to total (order becomes fully
prepaid, codDue 0); rounding of bps percentage HALF_UP; zero-total order
(fully discounted) → advance 0 / skip gateway entirely (confirm immediately —
flow handles as a no-payment fast path); minAdvance > total → advance =
total; codDue must equal total − advance exactly (invariant, asserted).

## 5.3 Promotions (`@platform/core/promotions` pure)

```ts
type CartForEvaluation = {
  lines: { variantId: string; productId: string; categoryIds: string[];
           quantity: number; unitPricePaise: number }[];
  subtotalPaise: number;
  shippingPaise: number;
  channel: "web" | "pos" | "whatsapp" | "manual";
};
type CustomerForEvaluation = { id: string | null; isFirstOrder: boolean } | null;

export const conditionSchema: z.ZodType<Condition>;   // blueprint §4.4 unions
export const effectSchema: z.ZodType<Effect>;
export function evaluatePromotion(promo: PromotionData, cart: CartForEvaluation,
  customer: CustomerForEvaluation, now: Date):
  | { applicable: true; discount: AppliedDiscount }
  | { applicable: false; reason: PromotionRefusalReason };  // typed: not_started|expired|condition_failed:<type>|...
export function applyDiscountToLines(lines, discount: AppliedDiscount):
  { lineDiscountsPaise: number[]; shippingPaise: number };   // largest-remainder, pre-tax
```

Edge cases: percent_off with maxDiscountPaise cap (and cap = 0);
flat_off > subtotal (clamp, never negative); free_shipping when shipping
already 0; buy_x_get_y with insufficient buy quantity, with getVariantIds
absent from cart (discount cheapest eligible present, else inapplicable),
and quantity multiples (2×buyQty → 2×getQty); first_order with null customer
(guest first visit → isFirstOrder true by definition of no prior orders for
the phone — computed by the server layer, pure fn just consumes the flag);
condition AND-semantics across the array (all must hold); empty conditions
(always applicable within window); window boundaries inclusive-start
exclusive-end; discount allocation across lines sums exactly (invariant);
zero-subtotal cart; channel mismatch. Phase 2 evaluates **one coupon code**
per cart (no stacking — documented; the array types don't preclude it later).

---

# 6. API surface

Envelope everywhere: `{ error: { code, message, details? }, requestId }`,
422 issues shape, `rejectMalformedId` on path ids. Console routes ride the
`handleCatalogWrite` pipeline with their own permission; storefront routes
resolve tenant from Host, no session actor, bounded bodies.

## Storefront (buyer, no auth)

| Route | Method | Zod payload | Notes |
| :-- | :-- | :-- | :-- |
| `/api/cart` | GET | — | cart view: lines priced live, availability, totals, applied coupon preview |
| `/api/cart` | POST | `{variantId: uuid, quantity: int 1..100}` | upsert line; 0 = remove |
| `/api/cart/coupon` | POST | `{code: string 1..40}` / DELETE | stores uppercased code on cart; evaluation read-only |
| `/api/checkout/serviceability` | POST | `{pincode: /^[1-9][0-9]{5}$/}` | precheck widget; cached |
| `/api/checkout` | POST | `{buyerName: 1..120, phone: E164, email?: email, shippingAddress: {line1, line2?, city, stateCode: 2, pincode}, buyerGstin?: GSTIN regex, paymentMode: "prepaid"\|"cod_advance"}` | §2.2; returns gateway hand-off |
| `/api/payments/webhook` | POST | raw body + signature header (no zod on body — gateway shape, parsed by adapter) | HMAC before everything; 256 KiB bound |
| `/order/[id]?t=<hmac>` | page | — | guest status page; token = HMAC(orderId, secret), constant-time compare |
| `/cart`, `/checkout` | pages | — | force-dynamic, uncached reads |

## Console (session + permission)

| Route | Method | Permission | Zod payload |
| :-- | :-- | :-- | :-- |
| `/api/orders` | GET | orders:read | query: `status?, q?, limit, offset` |
| `/api/orders/[id]` | GET | orders:read | — (detail incl. lines, payments, events timeline) |
| `/api/orders/[id]/transition` | POST | orders:write | `{to: "processing"\|"ready_to_ship"}` (Phase 2 manual subset) |
| `/api/orders/[id]/cancel` | POST | orders:cancel | `{reason?: string ≤500}` |
| `/api/promotions` | GET/POST | promotions:read/write | POST: `{code: /^[A-Z0-9_-]{3,40}$/i, name, status, startsAt?, endsAt?, conditions: Condition[], effects: Effect[] (min 1), usageLimitTotal?: int>0, usageLimitPerCustomer?: int>0}` |
| `/api/promotions/[id]` | PUT/DELETE | promotions:write | same shape; DELETE archives |
| `/api/settings/payments` | GET/PUT | payments:write (GET fingerprint only) | `{providerCode: "razorpay"\|"mock", publicKeyId: string, keySecret: string, webhookSecret: string, isEnabled: boolean}` — secrets sealed on write, never echoed |
| `/api/settings/invoicing` | PUT | settings:write (existing area) | `{prefix: 1..12}` (seeds future series rows) |
| Pages | | | `/orders`, `/orders/[id]`, `/orders/[id]/invoice` (print), `/promotions`, `/promotions/[id]`, `/settings/payments` |

Storefront checkout/cart pages and all commerce reads are **uncached**
(brief §4: live commerce reads bypass `unstable_cache`); PDP availability
keeps its existing cached+purged path.

---

# 7. Invoice rendering decision

**Recommendation: print-CSS HTML page (server-rendered React route), no PDF
dependency in Phase 2.**

- Console route `/orders/[id]/invoice` (and the same component reused on the
  guest order page for the buyer's copy) renders the `invoices` row — one
  SELECT, zero joins, the JSONB snapshot is the document. `@media print` CSS
  + `window.print()` gives every merchant a correct A4 tax invoice / bill of
  supply from any browser, which on a self-hosted single-VPS deployment
  costs **zero new dependencies, zero RAM, zero binaries**.
- Rejected: **headless Chromium** (puppeteer/playwright ≈ 300 MB image +
  ~150 MB RSS per render on a VPS that also runs Postgres/Redis/three Node
  apps — the heaviest possible dependency for a v1 whose users can press
  Ctrl+P); **pdfkit/react-pdf** (hand-coordinate layout means rebuilding the
  invoice twice — once in JSX, once in draw calls — and every future tweak
  twice; also poor Devanagari/Indic shaping out of the box, a real risk for
  merchant legal names).
- Forward path that costs nothing now: because the document is a
  self-contained HTML route keyed by invoice id, a Phase 3/4 "email PDF
  attachment" feature can bolt a worker-side renderer (single shared
  Chromium via `browserless` container or `wkhtmltopdf`) onto the SAME
  route with no schema or component change. IRN QR (Phase 3) is one more
  block in the component fed by `invoices.irn_qr`.

---

# 8. Test matrix

Unit = `packages/core/tests/*.test.ts` (no DB); integration =
`*.integration.test.ts` against the shared Docker Postgres, centrally
serialized. Counts are targets; builders report exact per-file counts for the
PROJECT_STATUS.md verified block (currently 325 unit / 238 integration).

| Suite (file) | Kind | Pins | ~n |
| :-- | :-- | :-- | --: |
| `core/tests/tax.test.ts` | unit | every §5.1 edge: inclusive extraction, per-line HALF_UP-then-sum, odd-paise CGST/SGST split invariant, IGST fork, reg-type zeros, rate 0, allocation exactness, FY boundary (Mar 31 / Apr 1 IST, and the UTC-vs-IST midnight trap) | 40 |
| `core/tests/promotions.test.ts` | unit | 100% branch: each Condition type pass/fail, each Effect, caps/clamps, buy_x_get_y multiples/absent-Y, window edges, refusal reasons, allocation sums, single-coupon rule | 45 |
| `core/tests/order-state-machine.test.ts` | unit | full transition matrix (every from→to pair asserted allowed/refused — 14×14 table-driven), terminality, Phase-2 manual subset | 15 |
| `core/tests/partial-payment.test.ts` | unit | §5.2 edges: clamps, floors, zero-total, exact codDue invariant | 10 |
| `core/tests/invoice-number.test.ts` | unit | formatInvoiceNumber padding/prefix, docTypeFor, series pick | 6 |
| `core/tests/payments-adapters.test.ts` | unit | mock driver determinism, razorpay HMAC verify (known-vector), parseWebhook shapes, registry fail-closed on unset/production NODE_ENV | 12 |
| `core/tests/checkout.integration.test.ts` | int | the spine: cart→checkout-start (order+snapshot+hold placed, order_number allocated, cart converted) → mock webhook → confirmed (consume movements reason `sale` with order reference, invoice row + gap-free number, coupon slot row, order_events); double-POST checkout replay; double webhook delivery = one confirmation (event-id unique + status gate) | 14 |
| `core/tests/checkout-concurrency.integration.test.ts` | int | two concurrent confirms on one series → distinct consecutive invoice numbers, rollback returns the number (forced failure keeps sequence gap-free); coupon slot race (23505→409); last-unit steal after hold lapse → order.oversold path, zero sale movements survive | 8 |
| `core/tests/cancel-refund.integration.test.ts` | int | confirmed→cancelled restocks (`cancellation_restock` in ledger, projection true, reconcile clean), refund job marks refund_initiated, refund webhook → refunded; shipped-state cancel refused 422; cancel of unpaid pending refuses invoice creation untouched | 8 |
| `core/tests/promotions-server.integration.test.ts` | int | CRUD, per-customer unique slot, total-limit exhaustion at checkout-start advisory, overredeemed flag path | 7 |
| `core/tests/payment-accounts.integration.test.ts` | int | seal/unseal roundtrip, AAD cross-tenant copy fails decrypt, fingerprint-only reads, one-enabled unique | 5 |
| `apps/storefront/tests/cart-checkout-routes.integration.test.ts` | int | cart cookie lifecycle, tenant-by-host isolation (cookie replay on other host → empty), zod 422 envelopes, serviceability refusal, webhook 401 on bad HMAC / 200 replay on dup event id, guest order token gate | 12 |
| `apps/console/tests/orders-routes.integration.test.ts` | int | list/detail authz, manual transition legal+illegal, cancel permission (`orders:cancel` vs role grants), timeline reads order_events | 8 |
| `apps/console/tests/promotions-routes.integration.test.ts` | int | CRUD + zod condition/effect validation refusals | 5 |
| `apps/worker/tests/order-jobs.integration.test.ts` | int | checkout.expire: releases holds + abandons; skips paid; re-enqueues extended expiry; refund job retry/backoff shape | 5 |
| RLS isolation | int | existing generated isolation suite auto-covers the 13 new tables (it derives from schema); add explicit cross-tenant probes for webhook route and coupon slots | 4 |
| **Totals** | | ~128 unit / ~76 integration added | |

Setup discipline per the brief: own tenants/plans/users via migrator client,
teardown in order, stock seeded through `recordMovement`, purge endpoint
stubbed on port 0, env restored before pool close. Existing 238 integration
tests (especially `stock-reservations.integration.test.ts`) must pass
untouched — the regression gate on the inventory refactor.

---

# 9. Build partitioning (~6 parallel builders + serial spine)

Serial spine first; then five parallel domain builders with **disjoint file
ownership**; then one serial integrator. Only B-INT may touch files owned by
others (none, in practice — it owns the orchestrator seam files created
empty by the spine).

**S0 — Schema spine (serial, first, coordinator-adjacent).**
Owns: `packages/db/src/schema/{commerce,payments,promotions}.ts`, `enums.ts`
additions, `schema/index.ts`, `rls.ts` appendOnly set,
`packages/core/package.json` exports (all new barrel entries registered
up-front with stub `index.ts`/`server.ts` files exporting types only),
`packages/core/src/queues.ts`, `identity/permissions.ts`,
**and the inventory refactor** (`consumeStockWithin`/`restockWithin`
extraction + StockHeldError rewording) since everyone downstream composes
with it. Coordinator runs `db:generate`/`db:migrate` after S0. Everything
below starts only when S0 merges and existing tests are green.

**B1 — Tax + invoices.** Owns `core/src/tax/*`, `core/src/invoices/*`,
`core/tests/tax.test.ts`, `invoice-number.test.ts`. Pure-heavy; exposes
in-tx `allocateInvoiceNumber`/`createInvoice` consumed later by B-INT.

**B2 — Promotions.** Owns `core/src/promotions/*`, console promotions
routes+pages, `core/tests/promotions*.test.ts`, console promotions route
tests. Exposes `evaluatePromotion`, `claimRedemption(tx)`,
`loadActivePromotion`.

**B3 — Payments.** Owns `core/src/payments/*`,
`integrations/src/payments/*`, console `/settings/payments` route+page,
adapter unit tests, payment-accounts integration test. Exposes adapter
registry, `getEnabledAccount`, `recordWebhookEvent`, `computeAdvanceSplit`.

**B4 — Cart + storefront surface.** Owns `core/src/cart/*`,
`core/src/serviceability/*`, `core/src/customers/server.ts`, storefront
`/cart` + `/api/cart*` + serviceability route + pages, `lib/cart-cookie.ts`,
`lib/order-token.ts`, storefront route tests (cart half).

**B5 — Orders domain + console.** Owns `core/src/orders/*` (state machine
pure table, transitionOrder door, queries, enqueue helper), `order_events`
usage, console orders routes/pages, invoice print page (renders B1's row
shape — types come from S0 stubs), state-machine unit test, console orders
route tests.

**B-INT — Checkout orchestration + worker (serial, after B1–B5).** Owns
`core/src/checkout/*`, storefront `/api/checkout*` + `/api/payments/webhook`
+ `/checkout` page wiring, `apps/worker/src/jobs/{order-events,gateway-refund}.ts`,
worker `queues.ts`/`index.ts` edits, and the cross-domain integration suites
(`checkout*`, `cancel-refund`, worker jobs). This is deliberately the ONLY
module importing multiple `/server` barrels, so parallel builders never
share a file. Integration runs are triggered here, serialized by the
coordinator per the brief.

Dependency edges: S0 → {B1..B5} (parallel) → B-INT. B4's checkout PAGE posts
to B-INT's route — the page ships in B4 behind the S0-stubbed payload type,
wired live by B-INT. Each parallel builder runs typecheck + lint + its unit
tests only; integration is centrally coordinated at S0-merge and B-INT.

---

*End of design. 13 new tables, 3 new schema files, ~15 new core modules on
the existing barrel pattern, 2 new queues, 1 surgical refactor of
inventory/server.ts, 0 new runtime dependencies (Razorpay driver uses plain
fetch + node:crypto).*
