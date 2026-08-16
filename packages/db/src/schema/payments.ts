import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
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

import {
  INVOICE_DOC_TYPES,
  PAYMENT_PROVIDER_CODES,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
  sqlLiteralList,
} from "./enums";
import type {
  InvoiceDocType,
  PaymentProviderCode,
  PaymentStatus,
  RefundStatus,
} from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";

/**
 * DATA PLANE — RLS-protected automatically (see rls.ts).
 *
 * BYOG payments (blueprint §5.2): per-tenant gateway credentials,
 * envelope-encrypted; funds never touch the platform. Webhooks — never
 * browser redirects — are the source of truth, idempotent on the gateway
 * event id via unique constraint. `payment_webhook_events` and `invoices`
 * are append-only BY GRANT (rls.ts appendOnly set).
 */

/** Money. BIGINT paise, never float, never INT (blueprint §3.1). */
const paise = (name: string) => bigint(name, { mode: "number" });

/** Money columns carry their currency explicitly (blueprint §3.1). */
const currency = () => char("currency", { length: 3 }).notNull().default("INR");

/**
 * A merchant's connection to one payment gateway — mirrors
 * carrier_accounts. TWO sealed blobs (design D7): the webhook route
 * unseals ONLY `sealed_webhook_secret`, never the API keys; both are
 * envelope-encrypted with AAD bound to (tenant_id, provider_code), so a
 * row copied between tenants fails to decrypt. Secrets are never logged
 * and never returned to the browser — the console shows a fingerprint.
 */
export const paymentAccounts = pgTable(
  "payment_accounts",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    providerCode: text("provider_code").$type<PaymentProviderCode>().notNull(),
    label: text("label").notNull().default("Default"),

    /** Razorpay key_id — public by design; the browser checkout needs it. */
    publicKeyId: text("public_key_id").notNull(),
    /** Envelope: {key_secret}. */
    sealedCredentials: text("sealed_credentials").notNull(),
    /** SEPARATE envelope blob (D7); webhook route unseals only this. */
    sealedWebhookSecret: text("sealed_webhook_secret").notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),

    isEnabled: boolean("is_enabled").notNull().default(false),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  },
  (t) => [
    uniqueIndex("payment_accounts_tenant_provider_label_key").on(
      t.tenantId,
      t.providerCode,
      t.label,
    ),
    // One live gateway per tenant in Phase 2 — getEnabledAccount relies on it.
    uniqueIndex("payment_accounts_one_enabled_key").on(t.tenantId).where(sql`is_enabled`),
    check(
      "payment_accounts_provider_check",
      sql`${t.providerCode} IN (${sql.raw(sqlLiteralList(PAYMENT_PROVIDER_CODES))})`,
    ),
  ],
);

/**
 * One row per gateway SALE attempt; mutable status (created → captured/
 * failed). Bare-uuid refs: a financial record outlives everything but
 * the tenant — the order may be purged, the account rotated or deleted.
 * fee_paise/fee_tax_paise land from the webhook payload (D17) so the
 * console can render gross − fee − fee GST = net settlement.
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    orderId: uuid("order_id").notNull(),
    paymentAccountId: uuid("payment_account_id").notNull(),
    providerCode: text("provider_code").$type<PaymentProviderCode>().notNull(),

    status: text("status").$type<PaymentStatus>().notNull().default("created"),
    amountPaise: paise("amount_paise").notNull(),
    currency: currency(),

    /** order_xxx. */
    gatewayOrderId: text("gateway_order_id"),
    /** pay_xxx — set by the webhook, never the redirect. */
    gatewayPaymentId: text("gateway_payment_id"),
    /** upi | card | netbanking … as reported by the gateway. */
    method: text("method"),
    /** Gateway fee from the webhook payload (D17). */
    feePaise: paise("fee_paise"),
    /** GST on the fee. */
    feeTaxPaise: paise("fee_tax_paise"),

    errorCode: text("error_code"),
    errorDescription: text("error_description"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payments_gateway_payment_key")
      .on(t.tenantId, t.gatewayPaymentId)
      .where(sql`gateway_payment_id IS NOT NULL`),
    index("payments_order_idx").on(t.tenantId, t.orderId),
    check(
      "payments_provider_check",
      sql`${t.providerCode} IN (${sql.raw(sqlLiteralList(PAYMENT_PROVIDER_CODES))})`,
    ),
    check(
      "payments_status_check",
      sql`${t.status} IN (${sql.raw(sqlLiteralList(PAYMENT_STATUSES))})`,
    ),
  ],
);

/**
 * Append-only raw webhook log — THE dedupe gate. The unique index on the
 * gateway event id is the idempotency mechanism (never an app-side
 * check). Raw payload is stored ONLY after HMAC verification. No
 * processed flag (D15): this row commits in its own small TX (evidence +
 * dedupe); processing is a second idempotent TX; a processing failure
 * returns 5xx and rides gateway redelivery. Append-only by grant.
 */
export const paymentWebhookEvents = pgTable(
  "payment_webhook_events",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    providerCode: text("provider_code").$type<PaymentProviderCode>().notNull(),
    /** x-razorpay-event-id; the mock driver supplies its own. */
    gatewayEventId: text("gateway_event_id").notNull(),
    eventType: text("event_type").notNull(),

    /** Bare uuids, resolved at receipt; nullable. */
    orderId: uuid("order_id"),
    paymentId: uuid("payment_id"),

    rawPayload: jsonb("raw_payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pwe_gateway_event_key").on(t.tenantId, t.providerCode, t.gatewayEventId),
    check(
      "pwe_provider_check",
      sql`${t.providerCode} IN (${sql.raw(sqlLiteralList(PAYMENT_PROVIDER_CODES))})`,
    ),
  ],
);

/**
 * Insert-once refund intents (D6). The UNIQUE on (tenant_id, payment_id)
 * makes double-cancel and webhook-retry races constraint-resolved, not
 * status-guarded — at most ONE refund per capture in Phase 2 (always the
 * full amount); a racer's 23505 replays the winner.
 */
export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    orderId: uuid("order_id").notNull(),
    paymentId: uuid("payment_id").notNull(),

    amountPaise: paise("amount_paise").notNull(),
    status: text("status").$type<RefundStatus>().notNull().default("pending"),
    /** 'merchant_cancelled' | 'stock_shortfall' | 'late_capture_abandoned'. */
    reason: text("reason").notNull(),
    gatewayRefundId: text("gateway_refund_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
  },
  (t) => [
    uniqueIndex("refunds_payment_key").on(t.tenantId, t.paymentId),
    check("refunds_amount_check", sql`${t.amountPaise} > 0`),
    check(
      "refunds_status_check",
      sql`${t.status} IN (${sql.raw(sqlLiteralList(REFUND_STATUSES))})`,
    ),
  ],
);

/**
 * Invoice number counter (blueprint 367–393 verbatim + hygiene).
 * Allocation is ONLY ever `UPDATE .. SET next_number = next_number + 1
 * .. RETURNING next_number - 1` inside the same transaction as the
 * payment confirmation — never MAX(n)+1, never an app counter, never a
 * Postgres SEQUENCE (non-transactional, leaves gaps). Rows are created
 * lazily inside the confirming tx: INSERT .. ON CONFLICT DO NOTHING,
 * then the UPDATE.
 */
export const invoiceSeries = pgTable(
  "invoice_series",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 'INV' (tax invoice) | 'BOS' (bill of supply). */
    seriesCode: text("series_code").$type<"INV" | "BOS">().notNull(),
    /** '2026-27', Indian FY, Asia/Kolkata boundary. */
    financialYear: text("financial_year").notNull(),
    prefix: text("prefix").notNull(),
    nextNumber: integer("next_number").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.seriesCode, t.financialYear] })],
);

/**
 * Append-only: an issued document never mutates. Fully self-contained
 * JSONB — seller, buyer and the full order_lines snapshot including the
 * tax split — so rendering needs one row and zero joins: the snapshot
 * rule taken to its conclusion. Bare-uuid order reference (history
 * ruling). IRN columns are Phase 3 e-invoicing room with no writer now;
 * the table stays strictly SELECT+INSERT by grant.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    orderId: uuid("order_id").notNull(),
    docType: text("doc_type").$type<InvoiceDocType>().notNull(),
    seriesCode: text("series_code").notNull(),
    financialYear: text("financial_year").notNull(),
    number: integer("number").notNull(),
    /** Rendered '{prefix}/{FY}/{padded number}', frozen at issue. */
    invoiceNumber: text("invoice_number").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),

    /** {legal_name, gstin, address, state_code, tax_registration_type}. */
    seller: jsonb("seller").notNull(),
    /** {name, phone, email?, gstin?, shipping_address}. */
    buyer: jsonb("buyer").notNull(),
    placeOfSupply: text("place_of_supply").notNull(),
    /** Full order_lines snapshot incl. tax split — THE render document. */
    lines: jsonb("lines").notNull(),

    subtotalPaise: paise("subtotal_paise").notNull(),
    discountPaise: paise("discount_paise").notNull(),
    taxablePaise: paise("taxable_paise").notNull(),
    cgstPaise: paise("cgst_paise").notNull(),
    sgstPaise: paise("sgst_paise").notNull(),
    igstPaise: paise("igst_paise").notNull(),
    totalPaise: paise("total_paise").notNull(),
    currency: currency(),

    /** Phase 3 e-invoicing room; no writer in Phase 2. */
    irn: text("irn"),
    irnQr: text("irn_qr"),
    irnRegisteredAt: timestamp("irn_registered_at", { withTimezone: true }),
  },
  (t) => [
    // Belt vs counter bugs: a duplicated number refuses to insert.
    uniqueIndex("invoices_series_number_key").on(
      t.tenantId,
      t.seriesCode,
      t.financialYear,
      t.number,
    ),
    // One invoice per order per document type.
    uniqueIndex("invoices_order_doc_key").on(t.tenantId, t.orderId, t.docType),
    check(
      "invoices_doc_type_check",
      sql`${t.docType} IN (${sql.raw(sqlLiteralList(INVOICE_DOC_TYPES))})`,
    ),
  ],
);
