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

import { TAX_REGISTRATION_TYPES, TENANT_STATUSES, sqlLiteralList } from "./enums";
import type { TaxRegistrationType, TenantStatus } from "./enums";

/**
 * CONTROL PLANE — deliberately not RLS-protected.
 *
 * These tables are queried *before* tenant context exists (resolving a
 * hostname to a tenant, listing which tenants a user may sign into), so
 * an RLS policy keyed on app.tenant_id could never be satisfied.
 *
 * Every table here is listed in PLATFORM_TABLES (src/rls.ts) with a
 * written justification. The isolation suite fails the build if a table
 * is neither RLS-protected nor explicitly justified — the exception has
 * to be a decision, never an oversight.
 */

export const plans = pgTable("plans", {
  id: uuid("id").primaryKey().$defaultFn(uuidv7),
  code: text("code").notNull().unique(), // 'internal', 'starter', 'growth'
  name: text("name").notNull(),
  pricePaiseMonthly: integer("price_paise_monthly").notNull().default(0),
  limits: jsonb("limits").notNull().default(sql`'{}'::jsonb`),
  isPublic: boolean("is_public").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    slug: text("slug").notNull(), // 'acme' → acme.<root domain>
    legalName: text("legal_name").notNull(),
    displayName: text("display_name").notNull(),

    status: text("status").$type<TenantStatus>().notNull().default("trial"),
    planId: uuid("plan_id").references(() => plans.id),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),

    // India tax identity. Drives Tax Invoice vs Bill of Supply and the
    // CGST/SGST vs IGST split (PLATFORM_BLUEPRINT.md §4.1).
    taxRegistrationType: text("tax_registration_type")
      .$type<TaxRegistrationType>()
      .notNull()
      .default("unregistered"),
    gstin: text("gstin"),
    originStateCode: text("origin_state_code"), // GST state code, e.g. '27'

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("tenants_slug_key").on(t.slug),
    index("tenants_status_idx").on(t.status),
    check("tenants_status_check", sql`${t.status} IN (${sql.raw(sqlLiteralList(TENANT_STATUSES))})`),
    check(
      "tenants_tax_reg_check",
      sql`${t.taxRegistrationType} IN (${sql.raw(sqlLiteralList(TAX_REGISTRATION_TYPES))})`,
    ),
  ],
);

/**
 * Hostname → tenant. The storefront's entry point for every request.
 *
 * `verifiedAt` is load-bearing for security, not just for UX: Caddy's
 * on-demand TLS `ask` endpoint refuses certificate issuance for any
 * hostname that is not verified here. Without that gate, anyone can
 * point DNS at our IP and burn our Let's Encrypt rate limit
 * (PLATFORM_BLUEPRINT.md §2.4).
 */
export const domains = pgTable(
  "domains",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    hostname: text("hostname").notNull(), // lowercase, no port, no scheme
    isPrimary: boolean("is_primary").notNull().default(false),

    // Set once DNS is confirmed to point at us. Gates TLS issuance.
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verificationToken: text("verification_token"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastCheckError: text("last_check_error"),

    // Apex → www canonicalisation. Non-null means 301 to this hostname.
    redirectTo: text("redirect_to"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("domains_hostname_key").on(t.hostname),
    index("domains_tenant_idx").on(t.tenantId),
  ],
);
