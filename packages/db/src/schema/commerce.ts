import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import {
  ACTOR_TYPES,
  CART_STATUSES,
  CHECKOUT_PAYMENT_MODES,
  ORDER_CHANNELS,
  ORDER_FULFILMENT_STATUSES,
  ORDER_LINE_KINDS,
  ORDER_PAYMENT_STATUSES,
  ORDER_STATUSES,
  PAYMENT_PROVIDER_CODES,
  sqlLiteralList,
} from "./enums";
import type {
  ActorType,
  CartStatus,
  CheckoutPaymentMode,
  OrderChannel,
  OrderFulfilmentStatus,
  OrderLineKind,
  OrderPaymentStatus,
  OrderStatus,
  PaymentProviderCode,
} from "./enums";
import { productVariants } from "./catalog";
import { tenants } from "./tenancy";
import { users } from "./identity";

/**
 * DATA PLANE — RLS-protected automatically (see rls.ts).
 *
 * The commerce spine: customers, carts, orders and their append-only
 * event timeline. FK-vs-bare-uuid follows the history-table ruling in
 * PHASE2_COMMERCE_DESIGN.md §1: live state (customers, carts, cart_lines)
 * gets real CASCADE FKs; long-lived records (orders) reference their
 * peers by bare uuid because snapshots carry the meaning; append-only
 * history (order_events) has NO FK to its subject and is append-only BY
 * GRANT (rls.ts appendOnly set).
 */

/** Money. BIGINT paise, never float, never INT (blueprint §3.1). */
const paise = (name: string) => bigint(name, { mode: "number" });

/** Money columns carry their currency explicitly (blueprint §3.1). */
const currency = () => char("currency", { length: 3 }).notNull().default("INR");

/**
 * Lean guest-checkout identity, upserted by phone at checkout. Exists for
 * two Phase 2 needs that require a stable buyer key: per-customer coupon
 * limits and the `first_order` promotion condition. No address table —
 * no login means no address book; delivery address is a JSONB snapshot
 * on the order.
 */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Checkout identity key. Stored E.164, same CHECK as users. */
    phoneE164: text("phone_e164").notNull(),
    /** Last seen; informational. */
    email: text("email"),
    name: text("name"),

    /** Set once, inside the first confirming transaction. */
    firstOrderAt: timestamp("first_order_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Blueprint soft-delete on customer tables (DPDP erasure requests). */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("customers_tenant_phone_key").on(t.tenantId, t.phoneE164),
    check("customers_phone_e164_check", sql`${t.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`),
  ],
);

/**
 * Cart identity = this row's UUIDv7 id in an httpOnly cookie scoped to
 * the storefront host. Non-enumerable, and a cookie replayed against
 * another tenant's host matches zero rows via RLS. Live state: real
 * CASCADE FKs, mutable, no reservation columns anywhere — holds are
 * stock_reservations rows keyed {type:'checkout', id: order_id}.
 */
export const carts = pgTable(
  "carts",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    status: text("status").$type<CartStatus>().notNull().default("active"),
    currency: currency(),

    /** Checkout-in-progress scratch; the order snapshots the final values. */
    buyerName: text("buyer_name"),
    buyerPhoneE164: text("buyer_phone_e164"),
    buyerEmail: text("buyer_email"),
    /** {line1, line2?, city, state_code, pincode} */
    shippingAddress: jsonb("shipping_address"),

    /** Uppercased at write; always re-evaluated server-side, never trusted. */
    couponCode: text("coupon_code"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The 30-day abandoned-cart GC sweep scans by staleness.
    index("carts_tenant_updated_idx").on(t.tenantId, t.updatedAt),
    check("carts_status_check", sql`${t.status} IN (${sql.raw(sqlLiteralList(CART_STATUSES))})`),
  ],
);

/**
 * No price columns: carts price live at read time; the snapshot happens
 * at order creation (blueprint line 365).
 */
export const cartLines = pgTable(
  "cart_lines",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),

    quantity: integer("quantity").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Upsert anchor: ON CONFLICT (tenant_id, cart_id, variant_id) DO UPDATE.
    uniqueIndex("cart_lines_cart_variant_key").on(t.tenantId, t.cartId, t.variantId),
    check("cart_lines_quantity_check", sql`${t.quantity} > 0 AND ${t.quantity} <= 100`),
  ],
);

/**
 * Order numbers are merchant-facing labels (gaps fine), allocated by the
 * same UPDATE..RETURNING recipe as invoice numbers because it is free and
 * race-proof. Deliberately NOT merged with invoice_series: order numbers
 * allocate at checkout-start, where invoice numbers must never. Rows are
 * created lazily (INSERT .. ON CONFLICT DO NOTHING) inside the first
 * allocating transaction.
 */
export const orderCounters = pgTable("order_counters", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  nextNumber: bigint("next_number", { mode: "number" }).notNull().default(1001),
});

/**
 * Cross-references (cart_id, customer_id, promotion_id) are bare uuids:
 * an order is a long-lived record whose snapshots carry the meaning, and
 * a FK in either direction would tie its lifetime to ephemeral state.
 * Only the status write door (`transitionOrder`) may mutate `status`.
 */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    orderNumber: bigint("order_number", { mode: "number" }).notNull(),
    channel: text("channel").$type<OrderChannel>().notNull().default("web"),
    status: text("status").$type<OrderStatus>().notNull().default("pending_payment"),
    paymentStatus: text("payment_status")
      .$type<OrderPaymentStatus>()
      .notNull()
      .default("pending"),
    /** Phase 3 logistics writes this; modeled now. */
    fulfilmentStatus: text("fulfilment_status")
      .$type<OrderFulfilmentStatus>()
      .notNull()
      .default("unfulfilled"),

    /** Bare uuid; anchor for the cart-scoped idempotency belt (D1a). */
    cartId: uuid("cart_id"),
    /** Bare uuid → customers. */
    customerId: uuid("customer_id"),
    /** Client-supplied (brief §2.5); the PRIMARY checkout idempotency key. */
    idempotencyKey: text("idempotency_key"),
    /** sha256 of the canonical checkout request — replay-mismatch guard (D1a). */
    checkoutFingerprint: text("checkout_fingerprint"),

    buyerName: text("buyer_name").notNull(),
    buyerPhoneE164: text("buyer_phone_e164").notNull(),
    buyerEmail: text("buyer_email"),
    /** {line1, line2?, city, state_code, pincode} — snapshot, never joined. */
    shippingAddress: jsonb("shipping_address").notNull(),
    /** GST state code, cross-checked against the pincode prefix (D3). */
    placeOfSupply: text("place_of_supply").notNull(),
    buyerGstin: text("buyer_gstin"),

    currency: currency(),
    paymentMode: text("payment_mode").$type<CheckoutPaymentMode>().notNull(),
    /** ITEM lines only, pre-discount, tax-inclusive (D16). */
    subtotalPaise: paise("subtotal_paise").notNull(),
    discountPaise: paise("discount_paise").notNull().default(0),
    /** The shipping LINE's gross. */
    shippingPaise: paise("shipping_paise").notNull().default(0),
    /** Informational sum of line tax — the lines are the truth (D16). */
    taxPaise: paise("tax_paise").notNull().default(0),
    totalPaise: paise("total_paise").notNull(),
    amountPaidPaise: paise("amount_paid_paise").notNull().default(0),
    codDuePaise: paise("cod_due_paise").notNull().default(0),
    /** Phase 3 writes; modeled now (blueprint §4.3 derived-and-synced state). */
    awbCodSyncedAt: timestamp("awb_cod_synced_at", { withTimezone: true }),

    /** Bare uuid → promotions; NULL when no coupon. */
    promotionId: uuid("promotion_id"),
    couponCodeSnapshot: text("coupon_code_snapshot"),

    /** Set at payment-start, not at order creation. */
    paymentProvider: text("payment_provider").$type<PaymentProviderCode>(),
    /** Gateway order id (order_xxx). */
    gatewayOrderRef: text("gateway_order_ref"),

    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    /** pending_payment TTL; readers filter read-side, exactly like holds. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_tenant_number_key").on(t.tenantId, t.orderNumber),
    // PRIMARY idempotency (D1a): fast-path SELECT, 23505 replay on race.
    uniqueIndex("orders_idem_key")
      .on(t.tenantId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    // Belt: one pending order per cart. The status predicate is the fix
    // for the brick bug — a hold-failure cancel leaves the index, so the
    // buyer's retry on the same cart is not replayed into a cancelled
    // order (D1a).
    uniqueIndex("orders_tenant_cart_pending_key")
      .on(t.tenantId, t.cartId)
      .where(sql`cart_id IS NOT NULL AND status = 'pending_payment'`),
    uniqueIndex("orders_gateway_ref_key")
      .on(t.tenantId, t.gatewayOrderRef)
      .where(sql`gateway_order_ref IS NOT NULL`),
    index("orders_tenant_status_idx").on(t.tenantId, t.status, t.placedAt),
    // Sweep scan + pending-coupon-claim counting.
    index("orders_expiry_idx").on(t.tenantId, t.status, t.expiresAt),
    index("orders_customer_idx").on(t.tenantId, t.customerId),
    check("orders_status_check", sql`${t.status} IN (${sql.raw(sqlLiteralList(ORDER_STATUSES))})`),
    check(
      "orders_payment_status_check",
      sql`${t.paymentStatus} IN (${sql.raw(sqlLiteralList(ORDER_PAYMENT_STATUSES))})`,
    ),
    check(
      "orders_fulfilment_status_check",
      sql`${t.fulfilmentStatus} IN (${sql.raw(sqlLiteralList(ORDER_FULFILMENT_STATUSES))})`,
    ),
    check(
      "orders_channel_check",
      sql`${t.channel} IN (${sql.raw(sqlLiteralList(ORDER_CHANNELS))})`,
    ),
    check(
      "orders_payment_mode_check",
      sql`${t.paymentMode} IN (${sql.raw(sqlLiteralList(CHECKOUT_PAYMENT_MODES))})`,
    ),
    check(
      "orders_payment_provider_check",
      sql`${t.paymentProvider} IN (${sql.raw(sqlLiteralList(PAYMENT_PROVIDER_CODES))})`,
    ),
    // D16 pinned semantics: subtotal is item lines only; tax is inside
    // (tax-inclusive default), so it does not appear in the identity.
    check(
      "orders_total_check",
      sql`${t.totalPaise} = ${t.subtotalPaise} - ${t.discountPaise} + ${t.shippingPaise}`,
    ),
    check("orders_amount_paid_check", sql`${t.amountPaidPaise} >= 0`),
    check("orders_cod_due_check", sql`${t.codDuePaise} >= 0`),
  ],
);

/**
 * The purchase-time snapshot (blueprint line 365): an order placed in
 * March reprints in October with March's price, title and tax rate.
 * Nothing that renders an order/invoice may join to live catalog rows.
 * Dies with its order (CASCADE); variant_id is a bare, nullable uuid —
 * the snapshot is authoritative.
 */
export const orderLines = pgTable(
  "order_lines",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),

    kind: text("kind").$type<OrderLineKind>().notNull().default("item"),
    variantId: uuid("variant_id"),

    titleSnapshot: text("title_snapshot").notNull(),
    /** '' for the shipping line. */
    skuSnapshot: text("sku_snapshot").notNull().default(""),
    hsnSnapshot: text("hsn_snapshot"),

    quantity: integer("quantity").notNull(),
    /** As displayed (tax-inclusive default). */
    unitPricePaise: paise("unit_price_paise").notNull(),
    /** This line's allocated share of the order discount, pre-tax. */
    discountPaise: paise("discount_paise").notNull().default(0),
    /** Post-discount, tax-EXCLUSIVE base. */
    taxablePaise: paise("taxable_paise").notNull(),
    taxRateBps: integer("tax_rate_bps").notNull(),
    /** Stored split, never recomputed (sum-invariant odd-paise rule, D18). */
    cgstPaise: paise("cgst_paise").notNull().default(0),
    sgstPaise: paise("sgst_paise").notNull().default(0),
    igstPaise: paise("igst_paise").notNull().default(0),
    /** = cgst + sgst + igst. */
    taxPaise: paise("tax_paise").notNull(),
    totalPaise: paise("total_paise").notNull(),

    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("order_lines_order_idx").on(t.tenantId, t.orderId),
    check(
      "order_lines_kind_check",
      sql`${t.kind} IN (${sql.raw(sqlLiteralList(ORDER_LINE_KINDS))})`,
    ),
    check("order_lines_quantity_check", sql`${t.quantity} > 0`),
  ],
);

/**
 * Append-only timeline AND the domain-event source row: the BullMQ job is
 * enqueued after commit with jobId = order_events.id (D11, Redis-deduped).
 * Bare-uuid order reference, no FK (audit_log precedent): a RESTRICT FK
 * breaks tenant cascade deletion, a CASCADE FK erases history. In the
 * rls.ts appendOnly grant set — SELECT + INSERT only. `actor_user_id`
 * FKs users because users is control-plane (audit_log precedent).
 */
export const orderEvents = pgTable(
  "order_events",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    orderId: uuid("order_id").notNull(),

    /** §5.2 catalog, e.g. 'order.confirmed', 'payment.amount_mismatch'. */
    event: text("event").notNull(),
    /** NULL for non-transition events. */
    fromStatus: text("from_status"),
    toStatus: text("to_status"),

    actorType: text("actor_type").$type<ActorType>().notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),

    data: jsonb("data"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("order_events_order_idx").on(t.tenantId, t.orderId, t.createdAt),
    check(
      "order_events_actor_type_check",
      sql`${t.actorType} IN (${sql.raw(sqlLiteralList(ACTOR_TYPES))})`,
    ),
  ],
);
