import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { PROMOTION_STATUSES, sqlLiteralList } from "./enums";
import type { PromotionStatus } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";

/**
 * DATA PLANE — RLS-protected automatically (see rls.ts).
 *
 * Promotions are rules-as-data (blueprint §4.4): Condition[]/Effect[]
 * JSONB, zod-validated at write, evaluated by a pure function. Usage
 * limits are enforced by the coupon_redemptions unique constraints,
 * NEVER a counter — counters race, and a coupon meant for 100 uses gets
 * used 340 times during a flash sale.
 */

/** Money. BIGINT paise, never float, never INT (blueprint §3.1). */
const paise = (name: string) => bigint(name, { mode: "number" });

export const promotions = pgTable(
  "promotions",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Uppercased at write. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    status: text("status").$type<PromotionStatus>().notNull().default("draft"),

    /** NULL = unbounded on that side. */
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),

    /** Condition[] (blueprint §4.4), zod-validated at write. */
    conditions: jsonb("conditions").notNull().default(sql`'[]'::jsonb`),
    /** Effect[]. */
    effects: jsonb("effects").notNull().default(sql`'[]'::jsonb`),

    /** NULL = unlimited. */
    usageLimitTotal: integer("usage_limit_total"),
    usageLimitPerCustomer: integer("usage_limit_per_customer"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  },
  (t) => [
    uniqueIndex("promotions_tenant_code_key").on(t.tenantId, t.code),
    check(
      "promotions_status_check",
      sql`${t.status} IN (${sql.raw(sqlLiteralList(PROMOTION_STATUSES))})`,
    ),
  ],
);

/**
 * Append-only; THE limit enforcer. Slot mechanics: inside the confirming
 * tx, `SELECT promotions FOR UPDATE` serializes slot computation, slot =
 * COUNT(*) for the promotion, customer_slot = COUNT(*) for (promotion,
 * customer); at limit → 422 coupon_exhausted; then INSERT. A racer that
 * slips past collides on the unique index → 23505 → 409 retry. Bare-uuid
 * references (history ruling); append-only by grant.
 */
export const couponRedemptions = pgTable(
  "coupon_redemptions",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    promotionId: uuid("promotion_id").notNull(),
    orderId: uuid("order_id").notNull(),
    customerId: uuid("customer_id"),

    /** 0-based position in the total-limit window. */
    slot: integer("slot").notNull(),
    customerSlot: integer("customer_slot").notNull().default(0),
    discountPaise: paise("discount_paise").notNull(),

    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cr_promo_slot_key").on(t.tenantId, t.promotionId, t.slot),
    uniqueIndex("cr_promo_customer_slot_key")
      .on(t.tenantId, t.promotionId, t.customerId, t.customerSlot)
      .where(sql`customer_id IS NOT NULL`),
    // One redemption per order — makes the confirm path replay-safe.
    uniqueIndex("cr_promo_order_key").on(t.tenantId, t.promotionId, t.orderId),
  ],
);
