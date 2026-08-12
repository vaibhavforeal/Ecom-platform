import { sql } from "drizzle-orm";
import {
  check,
  index,
  inet,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { ACTOR_TYPES, sqlLiteralList } from "./enums";
import type { ActorType } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";

/**
 * DATA PLANE — RLS-protected.
 *
 * Every table below carries tenant_id and is automatically given
 * FORCE ROW LEVEL SECURITY plus a tenant_isolation policy by
 * src/rls.ts. Nothing here needs to remember to filter by tenant:
 * PostgreSQL refuses to return other tenants' rows regardless of what
 * the application query says.
 *
 * From Phase 1 onward (products, orders, customers, inventory) every
 * new table lands here. Adding tenant_id is all that is required —
 * policies are derived, not hand-written, so they cannot drift.
 */

/**
 * Per-tenant configuration as key/value rather than a wide settings
 * table. Storefront theme, payment advance %, free-shipping threshold,
 * invoice prefix — all the things §0 of the blueprint forbids
 * hardcoding — live here and grow without a migration per setting.
 */
export const storeSettings = pgTable(
  "store_settings",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // 'payments.advance_pct', 'shipping.free_above_paise'
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

/**
 * Append-only audit trail. Required for staff accountability, and
 * independently required to make support impersonation defensible: when
 * platform staff can enter a merchant's console, there must be an
 * immutable record of what they did.
 *
 * No UPDATE or DELETE grant is issued on this table (see src/rls.ts) —
 * append-only is enforced by privilege, not by convention.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    actorType: text("actor_type").$type<ActorType>().notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),

    action: text("action").notNull(), // 'order.status_changed', 'product.price_updated'
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),

    before: jsonb("before"),
    after: jsonb("after"),

    ip: inet("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("audit_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    index("audit_actor_idx").on(t.tenantId, t.actorUserId),
    check("audit_actor_type_check", sql`${t.actorType} IN (${sql.raw(sqlLiteralList(ACTOR_TYPES))})`),
  ],
);
