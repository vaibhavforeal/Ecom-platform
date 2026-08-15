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
 */
export const STOCK_MOVEMENT_REASONS = ["opening_balance", "adjustment"] as const;
export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];
