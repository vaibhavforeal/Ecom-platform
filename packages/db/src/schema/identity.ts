import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { OTP_PURPOSES, ROLES, sqlLiteralList } from "./enums";
import type { OtpPurpose, Role } from "./enums";
import { tenants } from "./tenancy";

/**
 * CONTROL PLANE — see the note in tenancy.ts.
 *
 * Identity is deliberately global rather than per-tenant. A user is a
 * human with a phone number; membership is the tenant-scoped concept.
 * This is what lets one person staff several stores (agencies,
 * multi-brand owners) without duplicate accounts — a requirement that
 * is painful to retrofit once accounts are tenant-local.
 */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    // Phone-first: matches Indian user expectations and the OTP flow.
    // Stored E.164, e.g. +919876543210.
    phoneE164: text("phone_e164").notNull(),
    email: text("email"),
    name: text("name"),

    // TOTP secret, envelope-encrypted. Mandatory for owner/manager
    // before Phase 2 — SIM swap makes OTP-only a real threat to an
    // account holding payment credentials (PLATFORM_BLUEPRINT.md §7.1).
    totpSecretEncrypted: text("totp_secret_encrypted"),
    totpEnrolledAt: timestamp("totp_enrolled_at", { withTimezone: true }),

    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_phone_key").on(t.phoneE164),
    check("users_phone_e164_check", sql`${t.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`),
  ],
);

export const tenantMembers = pgTable(
  "tenant_members",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    role: text("role").$type<Role>().notNull(),

    // Per-member overrides on top of the role's default permission set.
    // Stored as data so Phase 2 merchants can define custom roles
    // without a deploy (PLATFORM_BLUEPRINT.md §7.2).
    permissionOverrides: jsonb("permission_overrides").notNull().default(sql`'{}'::jsonb`),

    invitedByUserId: uuid("invited_by_user_id").references(() => users.id),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index("tenant_members_user_idx").on(t.userId),
    check("tenant_members_role_check", sql`${t.role} IN (${sql.raw(sqlLiteralList(ROLES))})`),
  ],
);

/**
 * Opaque session tokens. We store only a SHA-256 hash: a leaked database
 * dump must not yield usable sessions.
 *
 * `tenantId` records which store the session is currently acting on, so
 * a multi-tenant user switching stores gets a fresh authorisation check
 * rather than carrying stale permissions across the boundary.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),

    userAgent: text("user_agent"),
    ipHash: text("ip_hash"), // hashed, not raw — data minimisation (DPDP)

    // Absolute and idle expiry are both enforced. Idle alone lets a
    // stolen token live forever under light use.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
  ],
);

/**
 * OTP challenges. The code is never stored in plaintext — we keep an
 * HMAC keyed by a server-side pepper, so database access alone does not
 * let an attacker complete a login.
 */
export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    phoneE164: text("phone_e164").notNull(),
    purpose: text("purpose").$type<OtpPurpose>().notNull(),

    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("otp_phone_purpose_idx").on(t.phoneE164, t.purpose),
    index("otp_expires_idx").on(t.expiresAt),
    check("otp_purpose_check", sql`${t.purpose} IN (${sql.raw(sqlLiteralList(OTP_PURPOSES))})`),
  ],
);
