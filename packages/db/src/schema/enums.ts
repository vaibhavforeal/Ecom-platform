// Stored as TEXT with a TypeScript union rather than a PG enum.
//
// PG enums are attractive until the first `ALTER TYPE ... ADD VALUE`,
// which cannot run inside a transaction and therefore breaks the
// expand/contract migration discipline in PLATFORM_BLUEPRINT.md §8.2.
// Text plus a compile-time union plus a CHECK constraint gets the
// same safety without the migration hazard.

/**
 * Renders a value list for a CHECK constraint.
 *
 * DDL cannot contain bind parameters, so interpolating these values
 * through Drizzle's `sql` template would emit `IN ($1, $2)` and fail at
 * migration time with "there is no parameter $1". The inputs are
 * compile-time constants from this file, and the quote-escaping keeps it
 * honest if that ever stops being true.
 */
export function sqlLiteralList(values: readonly string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
}

export const TENANT_STATUSES = ["trial", "active", "suspended", "churned"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const TAX_REGISTRATION_TYPES = [
  "unregistered", // issues Bill of Supply, not Tax Invoice
  "regular", // standard GST registration
  "composition", // composition scheme — cannot collect GST
] as const;
export type TaxRegistrationType = (typeof TAX_REGISTRATION_TYPES)[number];

export const ROLES = [
  "owner",
  "manager",
  "catalog_manager",
  "order_processor",
  "cashier",
] as const;
export type Role = (typeof ROLES)[number];

export const ACTOR_TYPES = [
  "staff",
  "customer",
  "system",
  "support_impersonation",
] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const OTP_PURPOSES = ["console_login", "customer_login"] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/**
 * Catalog publication state.
 *
 * `draft` is invisible to the storefront, `archived` keeps the row (and
 * therefore its slugs, its order history and its SEO redirects) while
 * removing it from listings. Merchants archive far more often than they
 * delete, and an archived product whose URL 404s throws away whatever
 * ranking that page had earned.
 */
export const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/**
 * Entities that own a public URL. `url_slugs` is keyed per tenant across
 * all of them, so a product and a category can never collide — which is
 * what makes flat `/{slug}` URLs possible later without a migration.
 */
export const SLUG_ENTITY_TYPES = ["product", "category", "collection"] as const;
export type SlugEntityType = (typeof SLUG_ENTITY_TYPES)[number];

/**
 * Media processing state.
 *
 * An upload is `pending` until the worker has produced its AVIF/WebP
 * derivatives. The storefront must never render a pending asset — that
 * is how you ship a page whose LCP image 404s.
 */
export const MEDIA_STATUSES = ["pending", "ready", "failed"] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/**
 * Supported logistics providers. Single source of truth: the DB CHECK
 * constraint, the adapter registry and the core domain types all derive
 * from this list, so adding a carrier cannot go half-done.
 *
 * Aggregators resell many carriers behind one API; direct carriers are
 * contracted with the merchant. See packages/core/src/logistics/types.ts.
 */
export const CARRIER_CODES = [
  // Aggregators
  "shiprocket",
  "shipmozo",
  "nimbuspost",
  // Direct carriers
  "ekart",
  "delhivery",
  "bluedart",
  "xpressbees",
  "dtdc",
  "ecom_express",
  // Development test double — never selectable in production
  "fake",
] as const;

export type CarrierCode = (typeof CARRIER_CODES)[number];

export const SEARCH_INDEXING_MODES = ["auto", "indexed", "noindex"] as const;
export type SearchIndexing = (typeof SEARCH_INDEXING_MODES)[number];

/**
 * Why stock moved. Deliberately minimal: order/RTO/POS reasons arrive as
 * migrations with their phases, and a new reason being a migration is a
 * feature — the CHECK constraint is the single source of truth.
 * `opening_balance` is chosen automatically for a variant's first
 * movement; everything merchant-initiated after that is `adjustment`.
 * `sale` is written ONLY by consumeStock (a consumed checkout hold) —
 * no route accepts a client-supplied reason. `cancellation_restock` is
 * written ONLY by restockWithin (pre-shipment order cancel); RTO reasons
 * arrive with Phase 3 logistics.
 */
export const STOCK_MOVEMENT_REASONS = [
  "opening_balance",
  "adjustment",
  "sale",
  "cancellation_restock",
] as const;
export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];

// ───────────────────────────────────────────────────────────────
// Phase 2 commerce core (orders, payments, promotions)
// ───────────────────────────────────────────────────────────────

/**
 * The FULL blueprint order-state set ships at once; the transition table
 * in `@platform/core/orders` is the gate that keeps Phase-3 edges
 * (RTO/returns) unreachable. Shipping the whole set now means those
 * phases are a code change, not a CHECK-constraint migration.
 */
export const ORDER_STATUSES = [
  "pending_payment",
  "confirmed",
  "processing",
  "ready_to_ship",
  "shipped",
  "out_for_delivery",
  "delivered",
  "rto_initiated",
  "rto_delivered",
  "return_requested",
  "return_picked",
  "refunded",
  "cancelled",
  "abandoned",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_PAYMENT_STATUSES = [
  "pending",
  "partially_paid",
  "paid",
  "refund_initiated",
  "refunded",
] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

/** Phase 3 logistics writes this; modeled now so history needs no backfill. */
export const ORDER_FULFILMENT_STATUSES = [
  "unfulfilled",
  "partially_shipped",
  "shipped",
  "delivered",
  "rto",
] as const;
export type OrderFulfilmentStatus = (typeof ORDER_FULFILMENT_STATUSES)[number];

export const ORDER_CHANNELS = ["web", "pos", "whatsapp", "manual"] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

/** How the buyer chose to pay at checkout (D5: full COD ships in Phase 2). */
export const CHECKOUT_PAYMENT_MODES = ["prepaid", "cod", "cod_advance"] as const;
export type CheckoutPaymentMode = (typeof CHECKOUT_PAYMENT_MODES)[number];

export const CART_STATUSES = ["active", "converted"] as const;
export type CartStatus = (typeof CART_STATUSES)[number];

/** BYOG gateways. `mock` is the dev/CI driver — fail-closed in production. */
export const PAYMENT_PROVIDER_CODES = ["razorpay", "mock"] as const;
export type PaymentProviderCode = (typeof PAYMENT_PROVIDER_CODES)[number];

export const PAYMENT_STATUSES = ["created", "authorized", "captured", "failed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REFUND_STATUSES = ["pending", "processing", "processed", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** Unregistered/composition tenants issue a Bill of Supply, never a Tax Invoice. */
export const INVOICE_DOC_TYPES = ["tax_invoice", "bill_of_supply"] as const;
export type InvoiceDocType = (typeof INVOICE_DOC_TYPES)[number];

export const PROMOTION_STATUSES = ["draft", "active", "archived"] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

/** Shipping is a taxable LINE on the order, not an afterthought column. */
export const ORDER_LINE_KINDS = ["item", "shipping"] as const;
export type OrderLineKind = (typeof ORDER_LINE_KINDS)[number];
