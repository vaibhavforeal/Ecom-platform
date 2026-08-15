import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { STOCK_MOVEMENT_REASONS, sqlLiteralList } from "./enums";
import type { StockMovementReason } from "./enums";
import { productVariants } from "./catalog";
import { tenants } from "./tenancy";
import { users } from "./identity";

/**
 * DATA PLANE — RLS-protected automatically (see rls.ts).
 *
 * The inventory ledger, blueprint §4.5. `stock_movements` is the source
 * of truth and is append-only BY GRANT (rls.ts gives the app role
 * SELECT + INSERT only); `stock_levels` is a projection kept true in the
 * same transaction by `@platform/core/inventory/server`, and its
 * CHECK (on_hand >= 0) is the oversell guard — two concurrent sales of
 * the last unit serialize on the row lock and the loser gets a
 * constraint violation, not silence.
 */

/**
 * Where stock sits. One auto-provisioned default per tenant until POS
 * (Phase 5) brings real multi-location; the column exists on the ledger
 * from day one because retrofitting NOT NULL onto append-only history
 * means backfill guesswork.
 */
export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: text("name").notNull().default("Default"),
    isDefault: boolean("is_default").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Exactly one default per tenant. `ensureDefaultLocation` relies on
    // this to make its get-or-create race-safe.
    uniqueIndex("locations_one_default_key").on(t.tenantId).where(sql`is_default`),
  ],
);

/**
 * The ledger. Append-only: no updated_at, no deleted_at, and the app
 * role has no UPDATE/DELETE grant.
 *
 * `variant_id` and `location_id` are bare uuids with NO foreign key —
 * the audit_log.entity_id precedent. A RESTRICT FK would make tenant
 * deletion fail mid-cascade (cascade order is unspecified), and CASCADE
 * would let a stray hard variant delete silently erase history. The
 * visibility SELECT in recordMovement is the write-time integrity check.
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    variantId: uuid("variant_id").notNull(),
    locationId: uuid("location_id").notNull(),

    /** +50 restock, -1 sale, +1 RTO. Never zero. */
    delta: integer("delta").notNull(),
    reason: text("reason").$type<StockMovementReason>().notNull(),

    /** Merchant free text — what answers "why does this say 3?". */
    note: text("note"),

    /** For future automated movements (orders, RTO). Unused this task. */
    referenceType: text("reference_type"),
    referenceId: uuid("reference_id"),

    /** Client-generated; makes a double-clicked adjust idempotent. */
    idempotencyKey: text("idempotency_key"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
  },
  (t) => [
    uniqueIndex("stock_movements_tenant_idem_key")
      .on(t.tenantId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    index("stock_movements_variant_idx").on(t.tenantId, t.variantId, t.createdAt),
    check("stock_movements_delta_check", sql`${t.delta} <> 0`),
    check(
      "stock_movements_reason_check",
      sql`${t.reason} IN (${sql.raw(sqlLiteralList(STOCK_MOVEMENT_REASONS))})`,
    ),
  ],
);

/**
 * The projection: available-to-display, always reconcilable against
 * SUM(stock_movements.delta). Reservations deliberately do NOT live here: available means
 * on_hand − SUM(active stock_reservations), computed at read time by
 * @platform/core/inventory/server.getAvailability — a hold expires by
 * being read as expired, never by a write.
 */
export const stockLevels = pgTable(
  "stock_levels",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),

    onHand: integer("on_hand").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.variantId, t.locationId] }),
    // The oversell guard. recordMovement maps a violation to a 422.
    check("stock_levels_on_hand_check", sql`${t.onHand} >= 0`),
  ],
);

/**
 * Checkout holds — live-only state, NOT history. A row exists exactly
 * while a hold is live: deleted on release/consume, and it stops
 * counting the moment expires_at passes even if it lingers (expiry is a
 * fact of READING — nothing has to run at expiry time). Consumption
 * history lives on stock_movements via reference_type/reference_id.
 *
 * Real CASCADE FKs, deliberately unlike the ledger: ephemeral state
 * should die with its subject, there is no history to preserve, and
 * every path is CASCADE, never RESTRICT, so tenant deletion cannot fail
 * mid-cascade. No idempotency_key: holdStock has replace semantics — a
 * hold is state, not an event.
 */
export const stockReservations = pgTable(
  "stock_reservations",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),

    quantity: integer("quantity").notNull(),

    /** Who holds: 'checkout' today; opaque to this module. */
    referenceType: text("reference_type").notNull(),
    referenceId: uuid("reference_id").notNull(),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live hold per reference per variant; replace semantics and the
    // concurrent-same-reference 409 both rest on this.
    uniqueIndex("stock_reservations_ref_variant_key").on(
      t.tenantId,
      t.referenceType,
      t.referenceId,
      t.variantId,
    ),
    // The active-sum path: WHERE variant_id = ? AND expires_at > now().
    index("stock_reservations_variant_idx").on(t.tenantId, t.variantId, t.expiresAt),
    check("stock_reservations_quantity_check", sql`${t.quantity} > 0`),
  ],
);
