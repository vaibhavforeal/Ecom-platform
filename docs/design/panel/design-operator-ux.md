# Phase 2 Commerce Core — Design (Operator/Merchant-First Angle)

Designer angle: merchant console ergonomics and buyer checkout UX drive the
API surface; schema is derived from what those pages need. All tenancy/RLS,
money, snapshot, and reservation rules per `CONVENTIONS_BRIEF.md` hold
unmodified.

Design-shaping decisions taken up front (each argued in its section):

- **Guest-first buyers, `customers` table anyway.** No buyer login in
  Phase 2; the order status page is reached via an unguessable token. But a
  tenant-scoped `customers` row is upserted by phone at checkout because
  `first_order` promotions, per-customer coupon limits, and the Phase 3 COD
  risk score are all impossible without one. Address book is deferred; the
  order carries an address snapshot.
- **A draft order IS the checkout.** Checkout-start creates a
  `pending_payment` order; the stock hold reference is
  `{type:'checkout', id: orderId}`. There is no separate checkout-session
  table — one fewer entity for the merchant to see and for us to reconcile.
- **Coupon slots are a mini-ledger, not a counter and not burn-on-abandon.**
  `coupon_redemptions` is append-only with `kind: redeem | release`;
  `promotions.redeemed_count` is the same-transaction projection with a
  CHECK — exactly the `stock_movements`/`stock_levels` doctrine, applied to
  coupons. Slots are taken at order creation (so enforcement happens while
  we can still refuse) and released when the checkout abandons.
- **Payment confirmation is ONE transaction**: consume stock + state
  transition + invoice allocation + invoice snapshot, atomically. This
  requires one small exported refactor in `inventory/server.ts`
  (`consumeStockInTx`) — argued in §2/§4.
- **Webhooks process inline in the route** (DB-only work; HMAC already
  verified; no outbound call needed), so 2xx is returned only after the
  confirming transaction commits. Worker handles the outbound direction
  only: gateway order creation, refunds, expiry sweep.
- **COD confirms at placement** and its invoice is allocated there (the
  invoice must travel with the parcel); prepaid confirms at webhook. Both go
  through the same `confirmOrder` write door.

Sections:
1. Schema
2. Flows with transaction boundaries
3. Order state machine & domain events
4. Module map
5. Pure-function signatures (GST, partial payment, promotions)
6. API surface & pages
7. Invoice rendering decision
8. Test matrix
9. Build partitioning

---

## 1. Schema

New files: `packages/db/src/schema/commerce.ts` (customers, carts, orders,
payments), `packages/db/src/schema/billing.ts` (invoice_series, invoices),
`packages/db/src/schema/promotions.ts`, `packages/db/src/schema/shipping.ts`
(zones + pincode directory). All tables below are **tenant-scoped RLS**
(automatic via `rls.ts`) except `pincode_directory` (argued inline).

### 1.1 Enum additions (`enums.ts`, TEXT + CHECK as always)

```ts
export const ORDER_STATUSES = [
  "pending_payment", "confirmed", "processing", "ready_to_ship", "shipped",
  "out_for_delivery", "delivered", "cancelled", "abandoned",
  "rto_initiated", "rto_delivered",            // reachable Phase 3; in the enum now
  "return_requested", "return_picked", "refunded",
] as const;

export const ORDER_PAYMENT_STATUSES = [
  "unpaid", "partially_paid", "paid", "refund_pending", "refunded",
] as const;

export const FULFILMENT_STATUSES = ["unfulfilled", "packed", "shipped", "delivered"] as const; // Phase 3 fills this in

export const PAYMENT_METHODS = ["prepaid", "cod", "partial_cod"] as const;

export const PAYMENT_ATTEMPT_STATUSES = [
  "created", "authorized", "captured", "failed", "refund_pending", "refunded",
] as const;

export const GATEWAY_CODES = ["razorpay", "mock"] as const; // mock = dev/CI only, fail-closed gate

export const INVOICE_DOC_TYPES = ["tax_invoice", "bill_of_supply", "credit_note"] as const;
// credit_note is RESERVED in Phase 2 (RTO/returns issue them in Phase 3) — enum value exists so no migration later.

export const PROMOTION_STATUSES = ["draft", "active", "paused", "archived"] as const;
export const REDEMPTION_KINDS = ["redeem", "release"] as const;
export const CART_STATUSES = ["active", "converted"] as const;

// Extend the existing list (migration extends the CHECK):
export const STOCK_MOVEMENT_REASONS = [
  "opening_balance", "adjustment", "sale",
  "cancellation_restock",   // written by cancelOrder pre-shipment
  "rto_restock",            // Phase 3 writes it; reason exists now so the CHECK migration ships once
] as const;
```

### 1.2 `customers` — tenant-scoped buyer identity (mutable, soft delete)

Deliberately NOT the global `users` table: a buyer belongs to a store, staff
belong to the platform. Merging them makes every buyer a platform account —
wrong trust boundary and an RLS hole.

```
customers
  id                uuid PK uuidv7
  tenant_id         uuid NOT NULL FK tenants CASCADE
  phone_e164        text NOT NULL              -- checkout identity key
  email             text
  name              text
  first_order_at    timestamptz                -- set once; powers first_order condition cheaply
  orders_count      int NOT NULL DEFAULT 0     -- projection, same-tx maintained by confirmOrder
  total_spent_paise bigint NOT NULL DEFAULT 0  -- projection; console list column
  cod_risk_note     text                       -- Phase 3 risk score lands beside it
  notes             text                       -- merchant free text
  created_at / updated_at timestamptz NOT NULL
  deleted_at        timestamptz                -- soft delete (blueprint §3.1)
UNIQUE (tenant_id, phone_e164) WHERE deleted_at IS NULL
CHECK phone ~ E.164 (same regex as users)
```

Addresses: **no address table in Phase 2.** The cart/order carries the typed
address as a jsonb snapshot (`{ name, phone, line1, line2?, city, pincode,
state_code, country: 'IN' }`). A reusable address book only pays off with
buyer login (Phase 4). Guest-only was considered and rejected because the
promotions engine and coupon limits need a stable customer key — phone gives
us one without any login UX.

### 1.3 `carts` + `cart_lines` — live state, real CASCADE FKs

Guest persistence: the cart id lives in an HMAC-signed, host-scoped cookie
(`cart=<uuid>.<sig>`, 30-day expiry, secret = existing internal secret
machinery). No customer linkage until checkout provides a phone.

```
carts
  id            uuid PK uuidv7
  tenant_id     uuid NOT NULL FK tenants CASCADE
  status        text NOT NULL DEFAULT 'active'   -- CHECK in CART_STATUSES
  customer_id   uuid FK customers SET NULL       -- linked at checkout-start
  coupon_code   text                             -- entered on cart; validated advisorily, enforced at order creation
  note          text                             -- buyer note to merchant
  created_at / updated_at timestamptz NOT NULL
INDEX (tenant_id, status, updated_at)            -- abandoned-cart list (Phase 3 messaging reads this)

cart_lines
  id            uuid PK uuidv7
  tenant_id     uuid NOT NULL FK tenants CASCADE
  cart_id       uuid NOT NULL FK carts CASCADE   -- live state dies with its subject
  variant_id    uuid NOT NULL FK product_variants CASCADE
  quantity      int NOT NULL CHECK > 0 AND <= 100
  created_at / updated_at timestamptz NOT NULL
UNIQUE (tenant_id, cart_id, variant_id)          -- upsert key; add-to-cart is qty merge
```

No price on cart lines — carts always price from live variants at read time
(a cart is not an order; stale prices in carts are a support-ticket machine).
Prices freeze only at the order snapshot.

### 1.4 `orders` + `order_lines` + `order_events`

`orders` is mutable (status transitions, COD sync fields); `order_lines` are
written once at creation (snapshot rule) and never updated; `order_events`
is append-only history.

```
orders
  id                  uuid PK uuidv7
  tenant_id           uuid NOT NULL FK tenants CASCADE
  order_number        text NOT NULL              -- 'ORD-1042'; allocated from order_counters at creation
  public_token        text NOT NULL              -- 32-byte url-safe random; buyer status page, no login
  channel             text NOT NULL DEFAULT 'web'
  status              text NOT NULL              -- CHECK in ORDER_STATUSES
  payment_status      text NOT NULL DEFAULT 'unpaid'
  fulfilment_status   text NOT NULL DEFAULT 'unfulfilled'
  payment_method      text NOT NULL              -- CHECK in PAYMENT_METHODS
  customer_id         uuid                       -- bare uuid, NO FK (order outlives customer soft-delete; history precedent)
  cart_id             uuid                       -- bare uuid, NO FK, provenance only
  contact_snapshot    jsonb NOT NULL             -- { name, phone, email? }
  shipping_address    jsonb NOT NULL             -- address snapshot (§1.2 shape)
  billing_address     jsonb                      -- null = same as shipping
  place_of_supply     text NOT NULL              -- GST state code, derived from pincode at creation
  buyer_gstin         text                       -- B2B field on the checkout form (optional)
  currency            char(3) NOT NULL DEFAULT 'INR'
  subtotal_paise      bigint NOT NULL            -- sum of line pre-discount taxable+tax (inclusive display)
  discount_paise      bigint NOT NULL DEFAULT 0
  shipping_paise      bigint NOT NULL DEFAULT 0  -- the taxable shipping line's gross
  tax_paise           bigint NOT NULL DEFAULT 0  -- informational sum of line taxes
  total_paise         bigint NOT NULL
  amount_paid_paise   bigint NOT NULL DEFAULT 0
  cod_due_paise       bigint NOT NULL DEFAULT 0  -- derived-and-synced; blueprint §4.3
  awb_cod_synced_at   timestamptz                -- null until Phase 3 pushes it to a courier
  applied_promotion_id uuid                      -- bare uuid; display + release path
  coupon_code_snapshot text                      -- what the buyer typed, frozen
  stock_shortfall     jsonb                      -- null, or [{variantId, qty}] when confirm consumed less than sold (§2.4)
  expires_at          timestamptz                -- pending_payment TTL target; null after leaving that state
  confirmed_at / cancelled_at / delivered_at timestamptz
  cancel_reason       text
  created_at / updated_at timestamptz NOT NULL
  created_by_user_id  uuid FK users              -- null for web channel; staff for 'manual' orders later
UNIQUE (tenant_id, order_number)
UNIQUE (tenant_id, public_token)
INDEX (tenant_id, status, created_at DESC)       -- the orders list page
INDEX (tenant_id, customer_id, created_at DESC)
CHECK totals >= 0; CHECK amount_paid <= total; CHECK cod_due >= 0

order_lines            -- written once; snapshot rule (blueprint 365)
  id                  uuid PK uuidv7
  tenant_id           uuid NOT NULL FK tenants CASCADE
  order_id            uuid NOT NULL FK orders CASCADE   -- lines die with their order (tenant cascade only; no order-delete path exists)
  variant_id          uuid                              -- bare uuid, nullable, NO FK (blueprint schema; catalog may be deleted later)
  title_snapshot      text NOT NULL
  sku_snapshot        text NOT NULL
  hsn_snapshot        text
  options_snapshot    jsonb NOT NULL DEFAULT '{}'
  quantity            int NOT NULL CHECK > 0
  unit_price_paise    bigint NOT NULL                   -- tax-inclusive as displayed
  line_discount_paise bigint NOT NULL DEFAULT 0         -- promotion effect apportioned per line (pre-tax)
  taxable_paise       bigint NOT NULL                   -- post-discount, tax-extracted base
  tax_rate_bps        int NOT NULL                      -- 0 for unregistered tenants
  cgst_paise / sgst_paise / igst_paise bigint NOT NULL DEFAULT 0
  tax_paise           bigint NOT NULL                   -- = cgst+sgst+igst, rounded per line HALF_UP
  total_paise         bigint NOT NULL
  is_shipping_line    boolean NOT NULL DEFAULT false    -- shipping is a taxable LINE (brief §GST)
INDEX (tenant_id, order_id)

order_events           -- append-only (add to rls.ts appendOnly set); bare uuids
  id            uuid PK uuidv7
  tenant_id     uuid NOT NULL FK tenants CASCADE
  order_id      uuid NOT NULL                    -- bare uuid, NO FK (history precedent)
  event         text NOT NULL                    -- 'order.confirmed', 'order.cancelled', ...
  from_status / to_status text                   -- null for non-transition events (payment.failed note)
  actor_type    text NOT NULL                    -- staff | customer | system (reuse ACTOR_TYPES)
  actor_user_id uuid
  data          jsonb NOT NULL DEFAULT '{}'
  request_id    text
  created_at    timestamptz NOT NULL DEFAULT now()
INDEX (tenant_id, order_id, created_at)          -- the console timeline reads this
```

`order_counters(tenant_id PK, next_number int NOT NULL DEFAULT 1)` — same
UPDATE..RETURNING pattern as invoice_series but per-tenant single row. Order
numbers may have gaps (abandoned orders); only invoice numbers are gap-free.

### 1.5 Payments: `gateway_accounts`, `payments`, `payment_webhook_events`

```
gateway_accounts       -- mirrors carrier_accounts exactly (proven pattern)
  id                      uuid PK uuidv7
  tenant_id               uuid NOT NULL FK tenants CASCADE
  gateway_code            text NOT NULL CHECK in GATEWAY_CODES
  label                   text NOT NULL
  sealed_credentials      text NOT NULL   -- envelope-encrypted {keyId, keySecret}; AAD = (tenant, gateway)
  sealed_webhook_secret   text NOT NULL   -- separate blob: webhook route needs ONLY this one
  credential_fingerprint  text NOT NULL   -- console shows last-4 style fingerprint, never the secret
  mode                    text NOT NULL DEFAULT 'test'  -- test | live; console badge
  is_enabled              boolean NOT NULL DEFAULT false
  cod_enabled             boolean NOT NULL DEFAULT true     -- merchant-level COD switch
  advance_pct_bps         int              -- partial-payment policy lives here, visible where credentials are managed
  min_advance_paise       bigint
  last_verified_at        timestamptz
  last_error              text
  created_at / updated_at timestamptz; updated_by_user_id uuid FK users
UNIQUE (tenant_id, gateway_code, label)
UNIQUE (tenant_id) WHERE is_enabled              -- exactly ONE live gateway per tenant in Phase 2; checkout never picks

payments               -- one row per gateway attempt; mutable status, bare-uuid subject
  id                  uuid PK uuidv7
  tenant_id           uuid NOT NULL FK tenants CASCADE
  order_id            uuid NOT NULL               -- bare uuid, NO FK (financial record outlives everything but the tenant)
  gateway_account_id  uuid NOT NULL               -- bare uuid (credential rotation must not touch payment history)
  gateway_code        text NOT NULL
  purpose             text NOT NULL DEFAULT 'order'   -- order | advance  (refunds are columns, not rows, in Phase 2)
  status              text NOT NULL CHECK in PAYMENT_ATTEMPT_STATUSES
  amount_paise        bigint NOT NULL CHECK > 0
  currency            char(3) NOT NULL DEFAULT 'INR'
  gateway_order_id    text                        -- razorpay order_xxx; set by the worker job
  gateway_payment_id  text                        -- pay_xxx; set by webhook
  method_detail       text                        -- 'upi' | 'card' | ... normalized from webhook
  fee_paise           bigint                      -- gateway fee from webhook payload — settlement economics
  fee_tax_paise       bigint                      -- GST on the fee
  refund_id           text                        -- gateway refund id (full refund only in Phase 2)
  refunded_paise      bigint NOT NULL DEFAULT 0
  refund_requested_at / refunded_at timestamptz
  error_code / error_reason text
  created_at / updated_at timestamptz NOT NULL
UNIQUE (tenant_id, gateway_code, gateway_payment_id) WHERE gateway_payment_id IS NOT NULL
INDEX (tenant_id, order_id)

payment_webhook_events -- append-only raw log (rls.ts appendOnly set)
  id                uuid PK uuidv7
  tenant_id         uuid NOT NULL FK tenants CASCADE
  gateway_code      text NOT NULL
  gateway_event_id  text NOT NULL       -- x-razorpay-event-id / mock uuid
  event_type        text NOT NULL       -- 'payment.captured', 'refund.processed', ...
  order_id          uuid                -- bare uuid, resolved from payload notes; null if unresolvable
  raw_payload       jsonb NOT NULL      -- stored BEFORE processing (brief: store raw payload)
  signature_valid   boolean NOT NULL
  processed_at      timestamptz         -- null = received but processing failed; retry path re-reads
  processing_error  text
  received_at       timestamptz NOT NULL DEFAULT now()
UNIQUE (tenant_id, gateway_code, gateway_event_id)   -- THE idempotency gate: replay = 23505 = 200 OK no-op
```

Note on `processed_at` being writable on an "append-only" table: this table
gets SELECT+INSERT+**UPDATE of processed_at/processing_error only** (column
grant), because the receive-then-process split needs a completion mark. The
raw payload and identity columns are never updatable. This is a deliberate,
documented narrowing — flagged for the rls.ts grant writer.

### 1.6 Invoices: `invoice_series`, `invoices`

```
invoice_series         -- blueprint 367–393 verbatim; tenant-scoped RLS; mutable (the counter)
  tenant_id       uuid NOT NULL FK tenants CASCADE
  series_code     text NOT NULL DEFAULT 'INV'      -- 'INV' | 'BOS' | 'CN' (credit notes, Phase 3)
  financial_year  text NOT NULL                    -- '2026-27'
  prefix          text NOT NULL                    -- merchant-editable in settings until first use
  next_number     int NOT NULL DEFAULT 1
PRIMARY KEY (tenant_id, series_code, financial_year)

invoices               -- append-only (rls.ts appendOnly set); the legal document, self-contained
  id                uuid PK uuidv7
  tenant_id         uuid NOT NULL FK tenants CASCADE
  order_id          uuid NOT NULL                  -- bare uuid, NO FK
  doc_type          text NOT NULL CHECK in INVOICE_DOC_TYPES
  series_code       text NOT NULL
  financial_year    text NOT NULL
  number            int NOT NULL                   -- from the UPDATE..RETURNING
  invoice_number    text NOT NULL                  -- rendered 'INV/2026-27/0042' — what appears on the doc
  issued_at         timestamptz NOT NULL DEFAULT now()
  seller_snapshot   jsonb NOT NULL                 -- legal_name, gstin, address, state_code, tax_registration_type
  buyer_snapshot    jsonb NOT NULL                 -- name, address snapshot, gstin?
  place_of_supply   text NOT NULL
  lines_snapshot    jsonb NOT NULL                 -- full line detail incl. HSN + per-line tax split (self-contained reprint)
  totals_snapshot   jsonb NOT NULL                 -- subtotal/discount/shipping/tax breakup per rate/total
  -- IRN room (blueprint §4.1): columns exist NOW, all nullable, no writer in Phase 2
  irn               text
  irn_status        text                           -- pending | generated | failed (unused Phase 2)
  signed_qr         text
  irn_payload       jsonb
UNIQUE (tenant_id, series_code, financial_year, number)   -- gap-free uniqueness backstop
UNIQUE (tenant_id, order_id, doc_type)                    -- one tax invoice per order (credit notes relax later via doc_type)
INDEX (tenant_id, issued_at)                              -- GSTR-1 export scans by period
```

### 1.7 Promotions: `promotions`, `coupon_redemptions`

```
promotions             -- mutable; rules-as-data (blueprint §4.4)
  id                       uuid PK uuidv7
  tenant_id                uuid NOT NULL FK tenants CASCADE
  code                     text                     -- null = automatic promotion; uppercased on write
  title                    text NOT NULL            -- 'Diwali 10%' — shows on invoice + order detail
  status                   text NOT NULL CHECK in PROMOTION_STATUSES
  conditions               jsonb NOT NULL DEFAULT '[]'   -- Condition[] (§5)
  effects                  jsonb NOT NULL DEFAULT '[]'   -- Effect[]
  starts_at / ends_at      timestamptz              -- ends_at null = open-ended
  usage_limit_total        int                      -- null = unlimited
  usage_limit_per_customer int                      -- null = unlimited
  redeemed_count           int NOT NULL DEFAULT 0   -- PROJECTION of redemptions ledger, same-tx, CHECK-guarded
  created_at / updated_at; created_by / updated_by uuid FK users
UNIQUE (tenant_id, code) WHERE code IS NOT NULL AND status <> 'archived'
CHECK (usage_limit_total IS NULL OR redeemed_count <= usage_limit_total)   -- the coupon_exhausted guard (23514 → 422)
CHECK (redeemed_count >= 0)

coupon_redemptions     -- append-only ledger (rls.ts appendOnly set); bare uuids
  id            uuid PK uuidv7
  tenant_id     uuid NOT NULL FK tenants CASCADE
  promotion_id  uuid NOT NULL
  customer_id   uuid NOT NULL
  order_id      uuid NOT NULL
  kind          text NOT NULL CHECK in REDEMPTION_KINDS   -- redeem | release
  discount_paise bigint NOT NULL
  created_at    timestamptz NOT NULL DEFAULT now()
UNIQUE (tenant_id, order_id, kind)               -- an order redeems once and releases at most once — the race-proof constraint
INDEX (tenant_id, promotion_id, customer_id)     -- per-customer count under the promo row lock
```

Why this satisfies "unique constraint, never a counter": the *correctness*
constraint is `UNIQUE (tenant_id, order_id, kind)` plus the CHECK on the
projection — `redeemed_count` is a reconcilable projection maintained in the
same transaction (identical doctrine to `stock_levels`), not a source of
truth. Per-customer limits are counted inside the transaction *after* the
`UPDATE promotions SET redeemed_count = redeemed_count + 1` has taken the
promo row lock, which serialises all redemptions of that promotion.

### 1.8 Serviceability: `shipping_zones` + `pincode_directory`

Phase 2 serviceability is merchant-declared (no live carrier yet): the
merchant says where they ship, what it costs, and where COD is allowed.
Phase 3's carrier `serviceability_cache` (already in schema) will *narrow*
these answers, not replace them.

```
shipping_zones         -- tenant-scoped, mutable; first-match-wins by position
  id                uuid PK uuidv7
  tenant_id         uuid NOT NULL FK tenants CASCADE
  name              text NOT NULL                -- 'Maharashtra', 'Metros', 'Rest of India'
  pincode_prefixes  jsonb NOT NULL DEFAULT '[]'  -- ['4','11','5601']; [] = catch-all
  is_serviceable    boolean NOT NULL DEFAULT true -- false = explicit block zone
  cod_enabled       boolean NOT NULL DEFAULT true
  shipping_paise    bigint NOT NULL DEFAULT 0    -- flat rate (gross, tax-inclusive like products)
  free_above_paise  bigint                       -- null = never free
  position          int NOT NULL DEFAULT 0
  created_at / updated_at; updated_by uuid FK users
INDEX (tenant_id, position)

pincode_directory      -- CONTROL PLANE (PLATFORM_TABLES entry + justification)
  pincode      text PRIMARY KEY                  -- '400001'
  state_code   text NOT NULL                     -- GST state code '27' — drives place_of_supply
  state_name   text NOT NULL
  district     text
```

`pincode_directory` justification for `PLATFORM_TABLES`: national reference
data with no tenant owner, read before/without tenant context is not needed
but the data is identical for every tenant; RLS would force per-tenant
duplication of ~19k rows. Read-only to the app role (SELECT grant only);
seeded by migration/script. This is the table that turns a typed pincode
into a GST place of supply and an auto-filled state field on the checkout
form.

### 1.9 RLS / grant classification summary

| Table | Plane | Mutability | appendOnly grant |
| --- | --- | --- | --- |
| customers, carts, cart_lines, orders, gateway_accounts, promotions, shipping_zones, invoice_series, order_counters | tenant RLS | mutable | no |
| order_lines | tenant RLS | insert-once by convention (writer never updates) | no (cascade delete with order needs DELETE via cascade only) |
| order_events, invoices, coupon_redemptions | tenant RLS | append-only | yes |
| payment_webhook_events | tenant RLS | append-only + column-scoped UPDATE (processed_at, processing_error) | yes (narrowed) |
| payments | tenant RLS | mutable (status lifecycle) | no |
| pincode_directory | control plane | read-only to app role | SELECT only |

---

## 2. Flows (transaction boundaries marked `[TX]`)

Notation: each `[TX n]` is one `withTenant(tenantId, tx => …)`. Everything
between TX blocks is non-transactional orchestration (fail-soft purges,
queue enqueues, HTTP responses). Buyer-side context is
`ReservationContext`-shaped (`{ tenantId, requestId }`, tenant from Host).

### 2.1 Add to cart (storefront, no holds)

1. Resolve tenant from Host; read/verify signed cart cookie (invalid/absent ⇒ new cart).
2. `[TX 1]` `cart/server.upsertLine`:
   - visibility SELECT on variant (active, not deleted, product active) — 404 otherwise;
   - get-or-create cart (INSERT … ON CONFLICT-free: cookie carries the id; a missing row means a stale cookie ⇒ create new);
   - upsert `cart_lines` on the `(cart, variant)` unique key, qty add-or-set;
   - `getAvailability(tx, [variantId])` — if requested > available for a tracked variant, **clamp** and return `{ clamped: true, available }` (buyer sees "only 3 left, we adjusted your cart"). Untracked = never clamped.
3. Respond with recomputed cart totals (pure `priceCart`, §5). Set cookie if new. No holds, no purge (carts are never cached).

### 2.2 Checkout-start → draft order + holds

`POST /api/checkout` payload: contact, shipping address (pincode-first),
`paymentMethod: prepaid|cod|partial_cod`, optional `buyerGstin`, optional
`couponCode` (may also ride in from the cart row).

1. Zod-validate; resolve `pincode → state_code` via `pincode_directory` (SELECT, control plane, outside tenant tx is fine — read-only reference).
2. `[TX 1] orders/server.createDraftOrder` — the big one:
   a. Re-SELECT cart + lines + live variants (visibility check on every line; deleted/archived line ⇒ 422 `cart_changed` with per-line issues).
   b. Resolve shipping zone (first match by prefix, `is_serviceable` gate ⇒ 422 `not_serviceable`; COD requested but `cod_enabled=false` on zone or gateway account ⇒ 422 `cod_unavailable`).
   c. Upsert `customers` by `(tenant, phone)`; capture `customer.firstOrderAt` for promotion eval.
   d. Pure pipeline: `evaluatePromotions(cart, promos, customer)` → `computeAdvanceSplit` → `priceOrder` (GST per line, discounts before tax, shipping as taxable line) — all pure, no IO.
   e. If a coupon applies: `UPDATE promotions SET redeemed_count = redeemed_count + 1 WHERE id = …` (row lock + CHECK ⇒ 23514 mapped to 422 `coupon_exhausted`); count per-customer redemptions under that lock ⇒ 422 `coupon_limit_reached`; INSERT `coupon_redemptions (kind='redeem')`.
   f. Allocate `order_number` via `order_counters` UPDATE..RETURNING.
   g. INSERT `orders` (status `pending_payment`, `expires_at = now() + 30 min`) + snapshot `order_lines` (incl. the shipping line) + `order_events('order.created')`. Mark cart `converted` **only later at confirm** — the cart stays `active` so an abandoned checkout still has its cart.
3. `holdStock({tenantId}, { reference: {type:'checkout', id: orderId}, lines })` — **its own TX inside the inventory module** (15-min TTL, replace semantics). On `insufficient_stock`: `[TX 2]` transition order → `abandoned` + release redemption (`kind='release'`, decrement projection) + event; return the 422 with per-line availability (buyer edits cart). *(Both failure codes handled; `stock_held` cannot occur on holdStock — it is a consume/adjust code — but the checkout confirm path in §2.4 handles it.)*
4. Branch on method:
   - **cod** (no gateway money): go directly to §2.4's confirm door (`confirmOrder`, one TX, `amountPaid=0`, `cod_due=total`). Respond with `{ orderToken, status: 'confirmed' }`.
   - **prepaid / partial_cod**: enqueue `payments` queue job `create-gateway-order` `{ tenantId, orderId, paymentId }` after committing `[TX 3]` INSERT `payments` row (status `created`, amount = total or advance). Respond `{ orderToken, status: 'pending_payment', paymentId }`.
5. Storefront payment step polls `GET /api/checkout/:orderToken` (~1 s) until the payment row carries `gateway_order_id`, then opens the Razorpay modal (key id is public; from a `checkoutParams` field the poll returns). *Rationale: outbound gateway calls run from the worker (resilience rules) at the cost of ≤ 2 s perceived latency; the mock driver resolves instantly in dev.*

### 2.3 Worker: `create-gateway-order` (queue `payments`)

1. `[TX 1]` load payment row + order + enabled gateway account (SELECTs).
2. Decrypt credentials (envelope, AAD `(tenant, gateway)`).
3. Adapter `createPaymentIntent` (Razorpay Orders API; `receipt = order.orderNumber`, `notes = { orderId, tenantId }`). Retries/backoff/circuit breaker per queue defaults.
4. `[TX 2]` write `gateway_order_id` onto the payment row.
   Terminal failure ⇒ payment row `failed` + `order_events('payment.gateway_error')`; buyer poll surfaces "payment temporarily unavailable — retry".

### 2.4 Webhook confirm (source of truth)

`POST /api/webhooks/payments/{tenantId}/{gatewayAccountId}` — hosted on the
**console** app (stable platform domain; storefront domains are per-tenant
and mid-onboarding). Tenant id from the path is acceptable here *only*
because the HMAC check against that tenant's stored secret is the
authentication: a forged tenant id fails signature verification. Verify
BEFORE any domain work, on the raw body.

1. Bounded raw-body read. `[TX 1]` SELECT gateway account (inside `withTenant`), unseal `sealed_webhook_secret`, verify HMAC — mismatch ⇒ 401, nothing stored (a signature failure is noise, not evidence).
2. `[TX 2]` INSERT `payment_webhook_events` (raw payload, `signature_valid=true`). 23505 on the event-id unique ⇒ already processed ⇒ **200 immediately** (idempotent replay).
3. Normalize via adapter `parseWebhookEvent`. For `payment.captured`:
4. `[TX 3] payments/server.applyGatewayEvent` → `orders/server.confirmOrder(tx-composed)` — ONE transaction:
   a. SELECT order FOR UPDATE (by `notes.orderId`, verified visible). Amount check: captured amount must equal the payment row's `amount_paise` (mismatch ⇒ store event, mark `processing_error`, alert — never partially confirm).
   b. Update `payments` row → `captured` (+ `gateway_payment_id`, `method_detail`, `fee_paise` if present).
   c. `consumeStockInTx(tx, ctx, { reference: {type:'checkout', id: orderId}, lines: ORDER lines })` — the order is the authority, never the hold rows. **Failure handling**: `insufficient_stock` / `stock_held` on a line ⇒ fall back to per-line consume inside the same tx; lines that fail are recorded in `orders.stock_shortfall` and the order STILL confirms (money is captured; refusing now strands funds). Event `order.stock_shortfall` puts it in the merchant's face (console banner: "sold without stock — resolve").
   d. State transition `pending_payment → confirmed` (also legal: `abandoned → confirmed` for a late webhook — hold expired, consume proceeds "unheld"). Illegal current state (e.g. `cancelled` after buyer cancelled + refund started) ⇒ mark event error, do NOT transition, flag for support.
   e. `payment_status` = `paid` (prepaid) or `partially_paid` (advance); set `amount_paid_paise`, recompute `cod_due_paise = total − paid`.
   f. Invoice: `UPDATE invoice_series … RETURNING` (get-or-create the `(tenant,'INV'|'BOS', FY)` row first — FY computed from `issued_at` in IST, April–March), INSERT `invoices` with seller/buyer/lines/totals snapshots. Doc type by `tenants.tax_registration_type` (`regular` ⇒ tax_invoice, else bill_of_supply with zero tax — already priced with 0 bps at order creation).
   g. Mark cart `converted`; bump `customers.orders_count/total_spent/first_order_at`; INSERT `order_events('order.confirmed')`; mark webhook event `processed_at`; `recordAudit` (actorType `system`).
5. After commit: enqueue `order-events` job (`order.confirmed` payload §3); purge storefront cache tags for affected products (stock changed). Respond 200.
6. `payment.failed` events: `[TX 3′]` payment row → `failed` + `order_events('payment.failed')`; order stays `pending_payment` until TTL (buyer can retry payment from the status page — a new `payments` row).
7. `refund.processed` events: `[TX 3″]` payment row refund fields + order `payment_status='refunded'` + event.

**COD confirm** reuses step 4's door with no payment row and no consume-hold
race (holds are fresh): `confirmOrder(ctx, { orderId, paidPaise: 0 })` runs
c–g identically. Invoice at confirm — the paper must travel with the parcel.

### 2.5 Abandoned expiry

Worker scheduled job `expire-checkouts` on `maintenance` (every 5 min,
`upsertJobScheduler`): `withPlatform` lists active tenants → per tenant
`withTenant`:

1. `[TX per order]` SELECT `pending_payment` orders with `expires_at < now()` FOR UPDATE SKIP LOCKED; per order: transition → `abandoned`, INSERT redemption `release` row + `redeemed_count − 1` (skip if none), `order_events('order.abandoned')`.
2. `releaseStock({tenantId}, {type:'checkout', id})` per order (own TX; idempotent; usually the hold already expired — belt and braces).
3. Enqueue `order.abandoned` domain event (Phase 3 abandoned-checkout messaging hooks here).
   Late `payment.captured` after this ⇒ §2.4's `abandoned → confirmed` transition; the confirm door re-takes a redemption? **No** — confirm checks for an existing `redeem` row for the order; if a `release` exists it re-redeems only if the CHECK allows, else confirms WITHOUT the discount reversal problem by honoring the priced order and logging `promotion.over_redeemed` (money already matches the discounted total; bounded, visible, rare).

### 2.6 Cancel / refund (Phase 2 scope: full refund, pre-shipment only)

Console button or buyer request (buyer path: status-page "cancel" allowed
only in `confirmed`, before `processing`).

1. `[TX 1] orders/server.cancelOrder`: SELECT order FOR UPDATE; transition guard (`confirmed|processing → cancelled` only; `ready_to_ship+` refuses 422 `invalid_transition` — the console button simply isn't rendered, the guard is the real wall); restock: per line with a consumed sale movement, `recordMovementInTx` reason `cancellation_restock`, `reference {type:'order_cancellation', id}`; skip lines in `stock_shortfall`; write events + audit; if `amount_paid > 0` set `payment_status='refund_pending'` + INSERT nothing new (refund tracked on the payment row).
2. After commit: enqueue `payments` job `refund-payment {tenantId, paymentId}` → worker calls adapter `refund` (idempotency key = paymentId), `[TX]` writes `refund_id`, status `refund_pending`; the `refund.processed` webhook (§2.4.7) completes it to `refunded`.
3. **Phase 3 stubs that exist now**: `invoices.doc_type='credit_note'` enum value + `series_code='CN'` convention (no writer); `rto_restock` movement reason (no writer); `payments.purpose` extensible; cancel of a *delivered* order (returns flow) is unreachable by the transition table. No partial refunds: `refund(amount)` is always the full captured amount in Phase 2.

---

## 3. Order state machine & domain events

### 3.1 Transition table (data, in the PURE barrel `@platform/core/orders`)

```ts
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ["confirmed", "abandoned"],
  abandoned:       ["confirmed"],                 // late webhook only (system actor)
  confirmed:       ["processing", "cancelled"],
  processing:      ["ready_to_ship", "cancelled"],
  ready_to_ship:   ["shipped"],                   // Phase 3 gates this on an AWB
  shipped:         ["out_for_delivery", "delivered", "rto_initiated"],
  out_for_delivery:["delivered", "rto_initiated"],
  rto_initiated:   ["rto_delivered"],             // ambiguous courier text maps HERE, never to rto_delivered
  rto_delivered:   [],                            // terminal (restock + credit note in Phase 3)
  delivered:       ["return_requested"],
  return_requested:["return_picked"],             // Phase 3
  return_picked:   ["refunded"],                  // Phase 3
  cancelled:       [], refunded: [],              // terminal
};
export function canTransition(from: OrderStatus, to: OrderStatus): boolean;
export function assertTransition(from: OrderStatus, to: OrderStatus): void; // throws 422 AppError invalid_transition
```

**Who may drive which edge** (enforced in `orders/server.transitionOrder`,
not the table — the table is topology, authorization is policy):

| Edge | Actor | Where |
| --- | --- | --- |
| pending_payment→confirmed, abandoned→confirmed | system (webhook / COD checkout) | confirmOrder only |
| pending_payment→abandoned | system (expiry job) | expire job only |
| confirmed→processing, processing→ready_to_ship | staff (`orders:write`) | console transition endpoint |
| ready_to_ship→shipped→…→delivered | staff in Phase 2 (manual buttons); carriers in Phase 3 | console transition endpoint |
| confirmed/processing→cancelled | staff, or customer while `confirmed` | cancelOrder |
| shipped/out_for_delivery→rto_initiated | staff Phase 2 | console transition endpoint |

Manual `shipped/delivered` buttons in Phase 2 are deliberate: merchants
fulfil by hand until logistics lands, and the state machine must be
exercised (and evented) from day one. The console renders ONLY the legal
next transitions for the current state — the guardrail is visible UX, and
the server guard is the wall behind it.

### 3.2 Enforcement points

- `transitionOrder(ctx, { orderId, to, reason? })` in `orders/server.ts` is
  the ONLY status writer (confirmOrder/cancelOrder/expire compose it
  in-transaction via `transitionOrderInTx`). It: locks the order row,
  `assertTransition`, updates status + timestamp columns, inserts
  `order_events`, `recordAudit`. Illegal ⇒ 422 `invalid_transition` with
  `{from, to, allowed}` in details.
- Stock side effects are bound to specific edges inside the same tx:
  confirm ⇒ consume; cancel ⇒ `cancellation_restock`; (Phase 3:
  rto_delivered ⇒ `rto_restock`).

### 3.3 Domain events

Queue: new `QUEUE_NAMES.orderEvents = "order-events"` (plus
`QUEUE_NAMES.payments = "payments"` for outbound gateway work). Producers:
`orders/server` enqueues AFTER commit (never inline in the tx). One BullMQ
job per event; job name = event name.

```ts
export type OrderDomainEvent = {
  tenantId: string;                       // TenantJob<T> rule
  orderId: string;
  event: "order.created" | "order.confirmed" | "order.abandoned" |
         "order.cancelled" | "order.processing" | "order.ready_to_ship" |
         "order.shipped" | "order.out_for_delivery" | "order.delivered" |
         "order.rto_initiated" | "order.stock_shortfall" |
         "payment.failed" | "payment.refunded" | "promotion.over_redeemed";
  occurredAt: string;                     // ISO, from the tx row
  requestId?: string | null;
  data: {                                 // snapshot-shaped, consumer never re-queries to render
    orderNumber: string; status: OrderStatus; totalPaise: number;
    codDuePaise: number; customerPhone?: string; publicToken?: string;
    extra?: Record<string, unknown>;      // edge-specific (shortfall lines, refund id)
  };
};
```

Consumer (Phase 2): one worker `order-events` handler that (a) logs
structured JSON per record (the analytics stub), (b) dispatches to a
`notifications` no-op stub keyed by event (Phase 3's WhatsApp/SMS plugs in
here without touching producers). The event log double-writes nothing — the
DB truth is `order_events`; the queue is fan-out transport only, so a lost
job loses a notification, never a fact.

---

## 4. Module map

Pure barrels must not touch `@platform/db`; `/server` files own IO. All new
barrels registered in `packages/core/package.json#exports`.

### packages/core (new)

| File | Responsibility (one line) |
| --- | --- |
| `src/tax/index.ts` | PURE GST engine: place-of-supply split, inclusive/exclusive extraction, per-line HALF_UP rounding, FY computation (IST), invoice-number formatting. |
| `src/tax/invoice-model.ts` | PURE `buildInvoiceModel(order, lines, tenant) → InvoiceDoc` — the render- and IRN-agnostic document model (also PURE barrel). |
| `src/tax/server.ts` | `allocateInvoiceInTx(tx, …)`: series get-or-create + UPDATE..RETURNING + `invoices` INSERT; `getInvoiceForOrder`, `listInvoices` (GSTR-1 export query stub). |
| `src/promotions/index.ts` | PURE `Condition`/`Effect` types, zod schemas, `evaluatePromotions(cart, promos, customer) → AppliedDiscount[]`, per-line apportionment. |
| `src/promotions/server.ts` | Promotion CRUD write door; `redeemCouponInTx` / `releaseCouponInTx` (projection + ledger + limits); `listPromotions` with redemption stats. |
| `src/orders/index.ts` | PURE statuses, `ORDER_TRANSITIONS`, `assertTransition`, event types/payloads, order-number/public-token formats. |
| `src/orders/server.ts` | `createDraftOrder`, `confirmOrder`, `transitionOrder(+InTx)`, `cancelOrder`, `getOrder`, `getOrderByToken`, `listOrders`, `expirePendingOrders`. |
| `src/cart/index.ts` | PURE cart types + `priceCart` (display totals, promo preview) — client-safe for the cart drawer. |
| `src/cart/server.ts` | `getOrCreateCart`, `upsertLine` (availability clamp), `removeLine`, `getCartView`; signed cart-cookie codec. |
| `src/checkout/index.ts` | PURE `computeAdvanceSplit`, checkout zod payload schema, `priceOrder` composition (promotions → shipping line → GST). |
| `src/checkout/server.ts` | `startCheckout` orchestration (§2.2) and `getCheckoutState` (the poll). |
| `src/payments/index.ts` | PURE `PaymentGatewayAdapter` interface, `GATEWAY_CODES`, `NormalizedGatewayEvent`, checkout-modal param types. |
| `src/payments/server.ts` | Gateway-account CRUD (envelope seal/unseal, fingerprint), `applyGatewayEvent` (webhook write door, §2.4), settlement summary query. |
| `src/shipping/index.ts` | PURE `matchZone(pincode, zones) → ZoneDecision` (prefix longest-match then position). |
| `src/shipping/server.ts` | Zone CRUD; `resolveServiceability(tenantId, pincode, cartWeight)`; `lookupPincode` (directory read). |

### packages/core (existing, changed — kept minimal)

| File | Change |
| --- | --- |
| `src/inventory/server.ts` | Extract bodies of `consumeStock`/`recordMovement` into exported `consumeStockInTx(tx, …)` / `recordMovementInTx(tx, …)` (wrappers keep exact current behavior + catch mapping); reword `StockHeldError.publicMessage` for the buyer path (per PHASE2_FOLLOWUPS). No semantic change; existing tests must pass untouched. |
| `src/queues.ts` | Add `payments`, `orderEvents` queue names. |
| `src/errors.ts` | Nothing structural; new code values only (documented list). |
| `src/identity/permissions.ts` | Add `orders:read/write`, `payments:read/write`, `promotions:read/write`, `shipping:write`, `customers:read` to `PERMISSIONS` + role maps (`order_processor` gains orders/payments read+write). |
| `package.json` | Register the six new barrel pairs in `exports`. |

### packages/db

| File | Change |
| --- | --- |
| `src/schema/commerce.ts`, `billing.ts`, `promotions.ts`, `shipping.ts` | New tables (§1). |
| `src/schema/enums.ts` | §1.1 additions incl. extending `STOCK_MOVEMENT_REASONS`. |
| `src/schema/index.ts` | Re-export new schema files. |
| `src/rls.ts` | `appendOnly` += order_events, invoices, coupon_redemptions, payment_webhook_events (with the column-scoped UPDATE carve-out); `PLATFORM_TABLES` += pincode_directory (written justification §1.8). |

### packages/integrations (new)

| File | Responsibility |
| --- | --- |
| `src/payments/razorpay.ts` | Razorpay adapter: Orders API create, HMAC verify (webhook + optional redirect signature), event normalization, refund. |
| `src/payments/mock.ts` | Mock driver: instant gateway ids, `emitWebhook(url, event, secret)` test helper; **fail-closed** — constructor throws unless `NODE_ENV` is explicitly `development`/`test` (fake-carrier precedent). |
| `src/payments/registry.ts` | `getGatewayAdapter(code)` with the production gate. |

### apps/worker

| File | Responsibility |
| --- | --- |
| `src/jobs/create-gateway-order.ts` | §2.3. |
| `src/jobs/refund-payment.ts` | §2.6 step 2. |
| `src/jobs/expire-checkouts.ts` | §2.5 scheduled sweep (maintenance fan-out pattern). |
| `src/jobs/order-events.ts` | §3.3 consumer (log + notification stub). |
| `src/queues.ts` / `src/index.ts` | Register queues/workers; new imports BELOW `import "./env"`. |

### apps/storefront

| File | Responsibility |
| --- | --- |
| `src/app/cart/page.tsx` + `src/components/cart/*` | Cart page + drawer (client components import PURE barrels only). |
| `src/app/checkout/page.tsx` + `src/components/checkout/*` | Stepper: contact → address (pincode auto-fills state, serviceability inline) → pay (COD / prepaid / advance radio with amounts) → gateway modal. |
| `src/app/order/[token]/page.tsx` | Buyer status page (no login): timeline, lines, amounts, cancel button while `confirmed`, invoice link. Force-dynamic, uncached. |
| `src/app/order/[token]/invoice/page.tsx` | Print-CSS invoice render (§7). |
| `src/app/api/cart/route.ts`, `api/cart/lines/[id]/route.ts` | Cart mutations. |
| `src/app/api/checkout/route.ts`, `api/checkout/[token]/route.ts` | Start + poll + retry-payment + buyer cancel. |
| `src/lib/cart-cookie.ts` | Cookie read/write helper. |

### apps/console

| File | Responsibility |
| --- | --- |
| `src/app/orders/page.tsx` | Orders list: status tabs, payment badges, COD-due column, search by number/phone. |
| `src/app/orders/[id]/page.tsx` + components | Detail: lines, `order_events` timeline, legal-transition buttons only, payment panel (gateway fee → **net settlement** line — the economics visibility ask), shortfall banner, cancel+refund dialog. |
| `src/app/orders/[id]/invoice/page.tsx` | Same print-CSS invoice, staff-side. |
| `src/app/customers/page.tsx` | Customers list (orders_count, total_spent). Read-only Phase 2. |
| `src/app/promotions/page.tsx`, `promotions/[id]/page.tsx` | List + builder: condition rows (typed selects) / effect rows, live "would this cart qualify?" preview via pure eval in the client, redemption progress bar. |
| `src/app/settings/payments/page.tsx` | Gateway onboarding: provider card, key/secret/webhook-secret form (never re-displayed; fingerprint after save), copyable webhook URL, test/live badge, "send test event" (mock), advance-% + COD toggles. |
| `src/app/settings/shipping/page.tsx` | Zone editor (ordered rows, prefix chips, COD toggle, rate, free-above). |
| `src/app/api/orders/**`, `api/promotions/**`, `api/settings/payments/**`, `api/settings/shipping/**` | Thin `handleCatalogWrite`-pattern routes (§6). |
| `src/app/api/webhooks/payments/[tenantId]/[accountId]/route.ts` | §2.4 webhook receiver (HMAC auth, no session). |

Existing console files changed: nav/layout (add Orders, Customers,
Promotions, settings entries) — additive only.

---

## 5. Pure-function signatures & edge cases

All in PURE barrels; 100% branch coverage targets; no DB, no Date.now()
hidden inside (clock passed in where relevant).

### 5.1 GST engine (`@platform/core/tax`)

```ts
export type GstLineInput = {
  grossPaise: number;          // post-discount line amount as displayed (qty × unit − lineDiscount)
  taxRateBps: number;          // 0..10000; 0 for unregistered/composition tenants
  inclusive: boolean;          // tenant default true
};
export type GstSplit = {
  taxablePaise: number; cgstPaise: number; sgstPaise: number;
  igstPaise: number; taxPaise: number; totalPaise: number;
};
export function computeLineGst(
  line: GstLineInput,
  sellerStateCode: string,
  placeOfSupply: string,
  registrationType: TaxRegistrationType,
): GstSplit;

export function summarizeTax(lines: GstSplit[]):        // sum of already-rounded lines — never re-round
  { byRate: Map<number, GstSplit>; total: GstSplit };
export function financialYear(at: Date): string;         // IST calendar, April–March → '2026-27'
export function formatInvoiceNumber(prefix: string, fy: string, n: number): string; // 'INV/2026-27/0042'
export function deriveDocType(t: TaxRegistrationType): "tax_invoice" | "bill_of_supply";
```

Edge cases (each a named unit test):
- inclusive extraction `tax = round(gross × r / (10000 + r))` HALF_UP; exclusive `tax = round(base × r / 10000)`; rounding at exactly .5 paise rounds up.
- rate 0 / unregistered / composition ⇒ all-zero split, taxable = gross, doc type bill_of_supply.
- intra-state odd tax paise: CGST = HALF_UP(tax/2), SGST = tax − CGST (halves must sum exactly; never round both).
- inter-state ⇒ IGST = full tax, CGST/SGST 0.
- discount applied BEFORE extraction (input is post-discount by contract; test guards the pipeline order via `priceOrder`).
- shipping line taxed at the max-rate line's rate (principal supply proxy); free shipping ⇒ no shipping line at all.
- per-line-then-sum vs sum-then-round divergence pinned by a crafted 3-line case that differs by 1 paise.
- FY boundary: March 31 23:59 IST vs April 1 00:00 IST (and the UTC trap: Mar 31 19:30 UTC is already April 1 IST).
- gross 0 (100%-off line) ⇒ zero split, no negative taxable.
- place_of_supply === sellerState with union territories (same-code compare only; no special-casing in Phase 2, documented).

### 5.2 Partial payment (`@platform/core/checkout`)

```ts
export type AdvancePolicy = { advancePctBps: number | null; fixedAdvancePaise?: number | null; minAdvancePaise: number | null };
export function computeAdvanceSplit(totalPaise: number, policy: AdvancePolicy):
  { advancePaise: number; codDuePaise: number };
```
Edges: pct rounds HALF_UP; clamp to `[minAdvance, total]`; fixed > total ⇒
advance = total (cod 0 ⇒ effectively prepaid); zero/null policy ⇒ refuse
partial_cod at checkout (422 `advance_not_configured`); advance === total ⇒
payment_status becomes `paid` not `partially_paid`; total 0 (full-discount
order) ⇒ skip gateway entirely, confirm like COD with cod_due 0.

### 5.3 Promotions (`@platform/core/promotions`)

```ts
export type Condition =
  | { type: "cart_subtotal_min"; paise: number }
  | { type: "contains_product"; productIds: string[] }
  | { type: "contains_category"; categoryIds: string[] }
  | { type: "first_order" }
  | { type: "channel"; channels: Channel[] };
  // customer_segment deferred to Phase 4 (no segments exist) — type reserved, evaluator throws unsupported_condition
export type Effect =
  | { type: "flat_off"; paise: number }
  | { type: "percent_off"; bps: number; maxDiscountPaise?: number }
  | { type: "free_shipping" };
  // buy_x_get_y deferred: needs cart-line mutation UX; type reserved, builder hides it, evaluator rejects it

export type EvalCart = { lines: { variantId; productId; categoryIds; quantity; unitPricePaise }[]; subtotalPaise; channel };
export type EvalCustomer = { firstOrderAt: Date | null } | null;   // null = unknown guest (cart preview)
export function evaluatePromotions(cart: EvalCart, promotions: PromotionRow[], customer: EvalCustomer, now: Date):
  AppliedDiscount | null;      // Phase 2: best single promotion wins; no stacking
export function apportionDiscount(discountPaise: number, lines: {grossPaise:number}[]): number[]; // largest-remainder, sums exactly
```
Edges: all conditions AND-ed; empty conditions = always; expired/not-started/
paused/draft ⇒ ineligible with a REASON (`{eligible:false, reason}` — the
builder preview and the buyer's "coupon not applied because…" both consume
it); percent cap binds; flat_off > subtotal clamps to subtotal (never
negative totals); free_shipping with already-free shipping = zero-value but
still "applied" (display); `first_order` with null customer in checkout ⇒
eligible only if the upserted customer has `first_order_at IS NULL`
(server passes the real row; cart preview shows "may apply");
apportionment of 100 paise over 3 lines = [34,33,33] and sums exactly;
tie between two promotions ⇒ larger discount wins, then older `created_at`
(deterministic).

### 5.4 Shipping zones (`@platform/core/shipping`)

```ts
export function matchZone(pincode: string, zones: ZoneRow[]):
  { zone: ZoneRow | null; serviceable: boolean; codAllowed: boolean; shippingPaise: (subtotal: number) => number };
```
Edges: longest-prefix match beats position; equal length ⇒ lowest position;
`[]` prefixes = catch-all; block zone (`is_serviceable=false`) matched first
⇒ not serviceable even if a later zone would match; free_above boundary is
`>=`; invalid pincode shape (non-`^[1-9][0-9]{5}$`) rejected before matching.

---

## 6. API surface

Envelope everywhere: `{ error: { code, message, details? }, requestId }`;
422 validation with `details.issues`. Console routes ride
`handleCatalogWrite` (authn → authz → bounded body → zod → domain →
respond). Storefront routes resolve tenant from Host, no session.
`rejectMalformedId` on every path id.

### 6.1 Storefront (buyer; no session)

| Route | Method | Zod payload (shape) | Notes |
| --- | --- | --- | --- |
| `/api/cart` | GET | — | Cart view (live-priced, promo preview). |
| `/api/cart` | POST | `{ variantId: uuid, quantity: int 1..100 }` | Add/merge; returns cart + `clamped?`. |
| `/api/cart/lines/[lineId]` | PUT/DELETE | `{ quantity }` / — | Update qty (0 = remove) / remove. |
| `/api/cart/coupon` | PUT | `{ code: string.max(40) }` | Advisory validate + attach to cart; DELETE clears. |
| `/api/serviceability` | GET `?pincode=` | — | `{ serviceable, codAllowed, shippingPaise, state, city }` — powers the address step inline check. |
| `/api/checkout` | POST | `{ contact:{name,phone,email?}, address:{line1,line2?,city,pincode,stateCode?}, paymentMethod, buyerGstin?, couponCode?, idempotencyKey }` | §2.2. Returns `{ orderToken, status, payment? }`. Idempotency key: partial-unique on orders (`tenant, idempotency_key`) — double-submit safe. |
| `/api/checkout/[token]` | GET | — | Poll: `{ status, payment: { state, checkoutParams? } }`. |
| `/api/checkout/[token]/retry-payment` | POST | `{}` | New `payments` row after a failed attempt (order still `pending_payment`). |
| `/api/orders/[token]/cancel` | POST | `{ reason?: string.max(500) }` | Buyer cancel; only while `confirmed`. |
| Pages | | | `/cart`, `/checkout`, `/order/[token]`, `/order/[token]/invoice` — all force-dynamic. |

### 6.2 Console (staff; session + permission)

| Route | Method | Authz | Payload / notes |
| --- | --- | --- | --- |
| `/api/orders` | GET | `orders:read` | Filters: `status[], paymentStatus, q (number/phone), from, to, limit, offset`. |
| `/api/orders/[id]` | GET | `orders:read` | Detail + lines + events + payments + invoice ref. |
| `/api/orders/[id]/transition` | POST | `orders:write` | `{ to: OrderStatus, note? }` → `transitionOrder`; 422 `invalid_transition`. |
| `/api/orders/[id]/cancel` | POST | `orders:write` | `{ reason: string.min(1) }` → cancel + refund enqueue. |
| `/api/customers` | GET | `customers:read` | List/search by phone/name. |
| `/api/promotions` | GET/POST | `promotions:read/write` | POST `{ code?, title, conditions: Condition[], effects: Effect[], startsAt?, endsAt?, usageLimitTotal?, usageLimitPerCustomer?, status }` (zod schemas from the pure barrel). |
| `/api/promotions/[id]` | PUT/DELETE | `promotions:write` | Update / archive (never hard-delete once redeemed). |
| `/api/settings/payments` | GET/POST | `payments:write` | POST `{ gatewayCode, label, keyId, keySecret, webhookSecret, mode, advancePctBps?, minAdvancePaise?, codEnabled }`; response returns fingerprint only. |
| `/api/settings/payments/[id]` | PUT/DELETE | `payments:write` | Enable/disable/rotate (rotation = new sealed blobs, fingerprint changes). |
| `/api/settings/payments/[id]/verify` | POST | `payments:write` | Enqueue a credential-verify job (adapter `verifyCredentials`); result lands in `last_verified_at/last_error`. |
| `/api/settings/shipping/zones` (+`/[id]`) | GET/POST/PUT/DELETE | `shipping:write` | Zone CRUD; reorder via `position`. |
| `/api/webhooks/payments/[tenantId]/[accountId]` | POST | HMAC (no session) | §2.4. 401 bad sig; 200 replay; 200 after commit. |
| Pages | | | §4's console list. |

Settlement economics on the order detail: gross captured − `fee_paise` −
`fee_tax_paise` = net, rendered per payment row and summed on a simple
`/orders` header stat for the filtered range — data already captured by the
webhook writer; no new table.

### 6.3 Buyer order-status auth

`public_token` is a 32-byte random urlsafe string stored on the order
(unique per tenant), embedded in the post-checkout redirect and (Phase 3)
WhatsApp message. Possession = read access to that one order + the cancel
action while `confirmed`. No expiry in Phase 2 (merchants want durable
links); rotation not needed because it grants nothing write-worthy after
`processing`.

---

## 7. Invoice rendering decision

**Recommendation: print-CSS HTML page, rendered from the pure
`InvoiceDoc` model. No PDF dependency in Phase 2.**

| Option | Dependency cost on a self-hosted VPS | Verdict |
| --- | --- | --- |
| **Print-CSS HTML** (chosen) | Zero. A Next page + `@media print` stylesheet; browser's own print-to-PDF produces the file. | Ships now; A4-correct with `@page` rules; trivially themeable per tenant later. |
| Headless render (Playwright/Chromium) | ~400 MB Chromium in the worker image, ~150–300 MB RSS per render burst — real money on the small VPS we don't even have yet; another crashable daemon. | Right answer *later*, only when Phase 3 messaging needs an attached PDF; slots in as a worker job that prints the SAME HTML route. |
| pdfkit / @react-pdf | Moderate dep, but hand-placed layout: GST invoice tables (HSN columns, per-rate tax summary, Hindi/regional fonts) become coordinate arithmetic; every merchant-requested tweak is engineering. | Rejected — highest ongoing cost for the least fidelity. |

Mechanics: `buildInvoiceModel` (pure) → shared `<InvoiceDocument doc={…}/>`
server component used by both `console/orders/[id]/invoice` and
`storefront/order/[token]/invoice`; header "Tax Invoice"/"Bill of Supply" by
`doc_type`; per-rate tax summary table; amount-in-words helper (pure, tested);
a visible "Print / Save as PDF" button calling `window.print()`. The IRN/QR
block is a conditional slot in the component that renders when
`invoices.irn` is non-null — Phase 3 e-invoicing needs zero layout rework.
Data ALWAYS from the `invoices` row snapshots — the page never joins catalog
or even `order_lines` (reprint fidelity by construction).

---

## 8. Test matrix

Unit (`packages/core/tests`, no DB) — ~150 new:

| Suite | Pins | ~Count |
| --- | --- | --- |
| `tax-gst.test.ts` | Every §5.1 edge: split, rounding, FY/IST boundary, doc type, number formatting, amount-in-words | 40 |
| `promotions-eval.test.ts` | 100% branch: each condition ×(pass/fail/absent), each effect, caps, clamps, reasons, tie-break, apportionment sums | 38 |
| `order-transitions.test.ts` | Full matrix legal×illegal (14 states), assertTransition error shape, terminal states empty | 22 |
| `advance-split.test.ts` | §5.2 edges | 12 |
| `shipping-zones.test.ts` | §5.4 edges | 12 |
| `invoice-model.test.ts` | buildInvoiceModel snapshots, per-rate summary, B2B gstin block, shortfall-immune | 10 |
| `checkout-pricing.test.ts` | priceOrder pipeline ORDER (discount→shipping line→tax), 1-paise divergence case, zero-total order | 12 |
| `payments-normalize.test.ts` | Adapter event normalization fixtures (razorpay payload shapes), mock driver fail-closed gate | 8 |

Integration (`*.integration.test.ts`, serialized centrally) — ~85 new:

| Suite | Pins | ~Count |
| --- | --- | --- |
| `packages/core/tests/orders-checkout.integration.test.ts` | createDraftOrder snapshots; order-number allocation under concurrency; hold placed with checkout reference; abandon releases coupon + stock; idempotent checkout replay | 14 |
| `packages/core/tests/payment-confirm.integration.test.ts` | ONE-tx confirm: consume+transition+invoice atomic; rollback returns invoice number (the gap-free proof); concurrent webhooks → one invoice (unique event id); stolen-stock shortfall path; abandoned→confirmed; amount-mismatch refusal | 16 |
| `packages/core/tests/coupon-redemption.integration.test.ts` | CHECK-guarded exhaustion under concurrent redeem (the flash-sale race); per-customer limit under lock; release/re-redeem; projection reconciles against ledger | 10 |
| `packages/core/tests/invoice-series.integration.test.ts` | UPDATE..RETURNING serialization (parallel allocations gap-free); FY get-or-create race; BOS vs INV series | 6 |
| `apps/console/tests/orders-routes.integration.test.ts` | List filters; transition endpoint guards (403 permission, 422 illegal); cancel+restock movement written; RLS: foreign tenant order 404 | 12 |
| `apps/console/tests/gateway-accounts.integration.test.ts` | Seal/unseal roundtrip; AAD cross-tenant copy fails decrypt; fingerprint-only responses; one-enabled unique | 7 |
| `apps/console/tests/payment-webhook.integration.test.ts` | HMAC reject; raw payload stored; event-id replay 200-noop; full captured→confirmed flow through the HTTP route; refund.processed | 10 |
| `apps/storefront/tests/cart-checkout.integration.test.ts` | Cookie roundtrip; clamp on availability; serviceability endpoint; COD instant confirm; buyer status page by token (and 404 on wrong token) | 12 |
| `apps/worker/tests/expire-checkouts.integration.test.ts` | Sweep transitions + releases; SKIP LOCKED under a concurrent confirm | 4 |
| `apps/worker/tests/create-gateway-order.integration.test.ts` | Mock adapter writes gateway_order_id; terminal failure marks payment failed | 4 |

Every suite creates its own tenants and tears down tenants→users→plans;
stock seeded via `recordMovement`; purge endpoint stubbed on port 0.
Existing counts (325 unit / 238 integration) never shrink; builders report
per-file adds for the coordinator's verified block.

---

## 9. Build partitioning (~6 builders, disjoint files, serial spine)

```
S0 ──► [B1 ∥ B2 ∥ B3 ∥ B4 ∥ B5] ──► S6 ──► (coordinator: migrate + integration run)
```

**S0 — Schema spine (serial, first; 1 builder).**
Owns: all of `packages/db/src/schema/*` changes, `rls.ts`, `enums.ts`,
`order_counters`, pincode_directory seed script, `packages/core/package.json`
exports (all barrels registered up front as empty stubs so parallel builders
never touch the same package.json), `queues.ts` names,
`identity/permissions.ts` additions. Exit: `db:generate` output reviewed by
coordinator; typecheck green with stub barrels.

Then five parallel builders with disjoint ownership (none touches another's
directory; all import only committed S0 stubs + existing public barrels):

**B1 — Tax & invoices.** `core/src/tax/*`, unit suites `tax-gst`,
`invoice-model`, integration `invoice-series`. Exposes
`allocateInvoiceInTx` for S6.

**B2 — Promotions.** `core/src/promotions/*`, console
`app/promotions/**` + `api/promotions/**`, suites `promotions-eval`,
`coupon-redemption`. Exposes `redeemCouponInTx`/`releaseCouponInTx`.

**B3 — Payments & gateway onboarding.** `core/src/payments/*`,
`integrations/src/payments/*`, console `settings/payments/**` + webhook
route file, worker `create-gateway-order.ts` + `refund-payment.ts`, suites
`payments-normalize`, `gateway-accounts`. Exposes `applyGatewayEvent`
(calls a `confirmOrder` signature frozen in S0's orders stub).

**B4 — Cart, shipping, storefront buyer UX.** `core/src/cart/*`,
`core/src/shipping/*`, storefront cart/checkout/order pages + `api/cart*`,
`api/serviceability`, `cart-cookie.ts`, console `settings/shipping/**`,
suites `shipping-zones`, `cart-checkout` (checkout POST test lands in S6).

**B5 — Orders domain & console orders UX.** `core/src/orders/*`
(transition table, createDraftOrder, transitionOrder, cancelOrder, queries),
the **small `inventory/server.ts` refactor** (`consumeStockInTx` extraction +
StockHeldError reword — B5 is the ONLY builder touching that file), console
`app/orders/**` + `api/orders/**`, customers page, suites
`order-transitions`, `orders-routes`. `confirmOrder` here consumes B1/B2's
`*InTx` functions — their signatures are frozen in S0 stubs, so B5 codes
against the stubs and S6 verifies the joint.

**S6 — Checkout orchestration spine (serial, last; 1 builder).**
Owns: `core/src/checkout/*`, storefront `api/checkout*` routes, worker
`expire-checkouts.ts` + `order-events.ts` + queue/worker registration in
`apps/worker/src/{queues,index}.ts`, console nav additions, and the
cross-module integration suites (`orders-checkout`, `payment-confirm`,
`payment-webhook`, worker suites). This is where the seams are proven; S6
has authority to flag (not silently fix) any stub-vs-implementation drift.

Serialization rationale: S0 before everyone (schema + frozen signatures =
the contract); S6 after everyone (orchestration is pure composition and the
only place two modules meet inside one transaction). Coordinator runs
migrations and the integration suite exactly once, after S6.

File-conflict audit: `package.json`/`queues.ts`/`permissions.ts`/nav are
S0- or S6-owned; `inventory/server.ts` is B5-owned; every app directory is
owned by exactly one builder. No two builders share a file.
