import { sql } from "drizzle-orm";
import {
  boolean,
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

import { CARRIER_CODES, sqlLiteralList } from "./enums";
import type { CarrierCode } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";

/**
 * DATA PLANE — RLS-protected (see store.ts).
 *
 * Carrier connections are per-tenant, because merchants bring their own
 * courier accounts. That is not a nicety: a merchant already contracted
 * with Delhivery or Ekart at negotiated rates will not give those up to
 * use a platform, so "bring your own carrier" is a precondition for
 * selling this to anyone.
 */



/**
 * A merchant's connection to one carrier.
 *
 * `sealedCredentials` holds an envelope-encrypted blob — a per-record
 * data key wrapped by a master key that lives outside the database, and
 * bound by AAD to (tenant, carrier). A dump of this table is useless
 * without the master key, and a row copied between tenants fails to
 * decrypt rather than handing one merchant another's carrier account.
 *
 * Credentials are NEVER stored in plaintext, never logged, and never
 * returned to the browser — the console shows only a fingerprint.
 */
export const carrierAccounts = pgTable(
  "carrier_accounts",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    carrierCode: text("carrier_code").$type<CarrierCode>().notNull(),
    /** Merchant-facing label — they may hold two accounts with one carrier. */
    label: text("label").notNull(),

    sealedCredentials: text("sealed_credentials").notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),

    isEnabled: boolean("is_enabled").notNull().default(false),
    /** Tiebreak order for the `preferred` selection strategy. Lower first. */
    priority: integer("priority").notNull().default(100),

    /** Registered pickup location / warehouse id at the carrier. */
    pickupLocationRef: text("pickup_location_ref"),

    /** Per-account overrides, e.g. a negotiated volumetric divisor. */
    capabilityOverrides: jsonb("capability_overrides").notNull().default(sql`'{}'::jsonb`),

    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  },
  (t) => [
    // One label per carrier per tenant, so a merchant can hold several
    // accounts with the same carrier (different rate cards or regions).
    uniqueIndex("carrier_accounts_tenant_carrier_label_key").on(
      t.tenantId,
      t.carrierCode,
      t.label,
    ),
    index("carrier_accounts_enabled_idx").on(t.tenantId, t.isEnabled),
    check(
      "carrier_accounts_code_check",
      sql`${t.carrierCode} IN (${sql.raw(sqlLiteralList(CARRIER_CODES))})`,
    ),
  ],
);

/**
 * Serviceability cache.
 *
 * Every checkout asks every enabled carrier whether it delivers to a
 * pincode. Uncached, that is N carrier API calls on the critical path
 * of a page a customer is waiting on — slow, rate-limited, and a hard
 * dependency on carrier uptime for the checkout to render at all.
 *
 * Cached per (carrier, lane, weight slab), with a TTL, checkout stays
 * fast and survives a carrier outage on stale-but-usable data.
 */
export const serviceabilityCache = pgTable(
  "serviceability_cache",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    carrierCode: text("carrier_code").$type<CarrierCode>().notNull(),
    fromPincode: text("from_pincode").notNull(),
    toPincode: text("to_pincode").notNull(),
    weightSlabGrams: integer("weight_slab_grams").notNull(),
    paymentMode: text("payment_mode").notNull(), // prepaid | cod

    /** Serialised ServiceabilityQuote[]. Empty array = not serviceable. */
    quotes: jsonb("quotes").notNull(),

    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("serviceability_lane_key").on(
      t.tenantId,
      t.carrierCode,
      t.fromPincode,
      t.toPincode,
      t.weightSlabGrams,
      t.paymentMode,
    ),
    index("serviceability_expiry_idx").on(t.expiresAt),
  ],
);

/**
 * Observed per-lane carrier performance.
 *
 * Feeds `laneSuccessScore` and the `balanced` selection strategy. The
 * point is to rank carriers on what they actually did on this lane for
 * this merchant, rather than on their sales deck — the cheapest carrier
 * is frequently the most expensive once RTO is priced in.
 *
 * Aggregated by pincode prefix rather than full pincode: a merchant
 * never accumulates enough shipments to a single pincode for the
 * numbers to mean anything.
 */
export const carrierLaneStats = pgTable(
  "carrier_lane_stats",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    carrierCode: text("carrier_code").$type<CarrierCode>().notNull(),
    fromPrefix: text("from_prefix").notNull(), // first 3 digits
    toPrefix: text("to_prefix").notNull(),
    paymentMode: text("payment_mode").notNull(),

    delivered: integer("delivered").notNull().default(0),
    rto: integer("rto").notNull().default(0),
    lost: integer("lost").notNull().default(0),
    /** Sum of days to delivery, for a running mean without a second table. */
    deliveryDaysSum: integer("delivery_days_sum").notNull().default(0),

    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("carrier_lane_stats_key").on(
      t.tenantId,
      t.carrierCode,
      t.fromPrefix,
      t.toPrefix,
      t.paymentMode,
      t.windowStart,
    ),
  ],
);
