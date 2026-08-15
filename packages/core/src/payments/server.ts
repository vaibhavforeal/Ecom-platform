import {
  and,
  desc,
  eq,
  inArray,
  not,
  paymentAccounts,
  payments,
  paymentWebhookEvents,
  refunds,
  withTenant,
} from "@platform/db";
import { PAYMENT_PROVIDER_CODES } from "@platform/db";
import type { PaymentProviderCode, Tx } from "@platform/db";

import { recordAudit } from "../audit/index";
import type { WriteContext } from "../catalog/writes";
import type { BuyerContext } from "../cart/index";
import { credentialFingerprint, openCredentials, sealCredentials } from "../crypto/index";
import { EnvelopeError } from "../crypto/index";
import { AppError } from "../errors";
import { REFUND_REASONS } from "./index";
import type { GatewayCredentials, RefundReason } from "./index";

/**
 * Payments — SERVER barrel. Implemented by lot B3.
 *
 * Locked rules: TWO sealed envelope blobs per account (D7) with AAD
 * bound to (tenant_id, provider_code); the webhook route unseals ONLY
 * the webhook secret; secrets are never echoed (fingerprint only);
 * webhook idempotency is the pwe_gateway_event_key unique constraint,
 * never an app-side check; refunds are insert-once rows (D6).
 */

/**
 * AAD contexts for the two blobs. DELIBERATELY DISTINCT (D7): the same
 * (tenant, provider) pair yields a different AAD per blob, so
 * `unsealWebhookSecret` handed the API-key blob (or vice versa) fails
 * authentication instead of quietly decrypting the wrong secret — the
 * least-privilege split is enforced by the cipher, not by convention.
 * Changing either string breaks every existing row; never edit them.
 */
export function paymentCredentialsAad(tenantId: string, providerCode: string): string {
  return `payment_account:credentials:${tenantId}:${providerCode}`;
}

export function paymentWebhookSecretAad(tenantId: string, providerCode: string): string {
  return `payment_account:webhook:${tenantId}:${providerCode}`;
}

/** Walks err.cause chains for the root Postgres error code / text. */
function pgError(err: unknown): { code?: string; text: string } {
  let code: string | undefined;
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    const c = (cur as { code?: unknown }).code;
    if (!code && typeof c === "string") code = c;
    parts.push(String((cur as Error).message ?? cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return { code, text: parts.join(" ⇐ ") };
}

function refuse(code: string, path: string, message: string): never {
  throw new AppError({
    code,
    message: `Payments write refused: ${message}`,
    status: 422,
    publicMessage: "Some fields need attention.",
    details: { issues: [{ path, message }] },
  });
}

/** Fingerprint-only console view — secrets are NEVER in this shape. */
export type PaymentAccountView = {
  id: string;
  providerCode: PaymentProviderCode;
  label: string;
  publicKeyId: string;
  credentialFingerprint: string;
  isEnabled: boolean;
  lastVerifiedAt: Date | null;
  lastError: string | null;
};

export type UpsertPaymentAccountInput = {
  providerCode: PaymentProviderCode;
  label?: string;
  publicKeyId: string;
  /** Sealed into sealed_credentials — write-only, never re-displayed. */
  keySecret: string;
  /** Sealed into sealed_webhook_secret (SEPARATE blob, D7) — write-only. */
  webhookSecret: string;
  isEnabled: boolean;
};

const VIEW_COLUMNS = {
  id: paymentAccounts.id,
  providerCode: paymentAccounts.providerCode,
  label: paymentAccounts.label,
  publicKeyId: paymentAccounts.publicKeyId,
  credentialFingerprint: paymentAccounts.credentialFingerprint,
  isEnabled: paymentAccounts.isEnabled,
  lastVerifiedAt: paymentAccounts.lastVerifiedAt,
  lastError: paymentAccounts.lastError,
} as const;

/**
 * Create-or-replace the tenant's gateway connection. Both secrets are
 * sealed BEFORE the transaction opens (no plaintext near the pool), each
 * into its own envelope with its own AAD (D7). Enabling an account
 * disables every other one in the same transaction — one live gateway
 * per tenant in Phase 2; the partial unique index is the belt under a
 * concurrent enable, mapped to 409.
 */
export async function upsertPaymentAccount(
  ctx: WriteContext,
  input: UpsertPaymentAccountInput,
): Promise<PaymentAccountView> {
  if (!PAYMENT_PROVIDER_CODES.includes(input.providerCode)) {
    refuse("invalid_payload", "providerCode", "Unknown payment provider.");
  }
  const label = (input.label ?? "Default").trim();
  if (label.length === 0 || label.length > 80) {
    refuse("invalid_payload", "label", "Label must be 1–80 characters.");
  }
  if (!input.publicKeyId.trim() || input.publicKeyId.length > 200) {
    refuse("invalid_payload", "publicKeyId", "Enter the gateway key id.");
  }
  if (!input.keySecret || input.keySecret.length > 500) {
    refuse("invalid_payload", "keySecret", "Enter the gateway key secret.");
  }
  if (!input.webhookSecret || input.webhookSecret.length > 500) {
    refuse("invalid_payload", "webhookSecret", "Enter the webhook secret.");
  }
  const publicKeyId = input.publicKeyId.trim();

  // keyId rides inside the credentials blob alongside the secret: the
  // frozen unseal signature receives only (providerCode, sealedCredentials)
  // and must return full GatewayCredentials. keyId is public by design
  // (the public_key_id column), so sealing a copy leaks nothing.
  const sealedCredentials = sealCredentials(
    { keyId: publicKeyId, keySecret: input.keySecret },
    paymentCredentialsAad(ctx.tenantId, input.providerCode),
  );
  const sealedWebhookSecret = sealCredentials(
    { webhookSecret: input.webhookSecret },
    paymentWebhookSecretAad(ctx.tenantId, input.providerCode),
  );
  const fingerprint = credentialFingerprint(sealedCredentials);

  try {
    return await withTenant(ctx.tenantId, async (tx) => {
      const [existing] = await tx
        .select(VIEW_COLUMNS)
        .from(paymentAccounts)
        .where(
          and(
            eq(paymentAccounts.tenantId, ctx.tenantId),
            eq(paymentAccounts.providerCode, input.providerCode),
            eq(paymentAccounts.label, label),
          ),
        )
        .limit(1);

      if (input.isEnabled) {
        // One live gateway per tenant: enabling this one turns the others
        // off in the SAME transaction, before the insert can trip the
        // payment_accounts_one_enabled_key partial unique index.
        await tx
          .update(paymentAccounts)
          .set({ isEnabled: false, updatedAt: new Date(), updatedByUserId: ctx.actorUserId })
          .where(
            and(
              eq(paymentAccounts.tenantId, ctx.tenantId),
              eq(paymentAccounts.isEnabled, true),
              not(
                and(
                  eq(paymentAccounts.providerCode, input.providerCode),
                  eq(paymentAccounts.label, label),
                )!,
              ),
            ),
          );
      }

      const [row] = await tx
        .insert(paymentAccounts)
        .values({
          tenantId: ctx.tenantId,
          providerCode: input.providerCode,
          label,
          publicKeyId,
          sealedCredentials,
          sealedWebhookSecret,
          credentialFingerprint: fingerprint,
          isEnabled: input.isEnabled,
          updatedByUserId: ctx.actorUserId,
        })
        .onConflictDoUpdate({
          target: [paymentAccounts.tenantId, paymentAccounts.providerCode, paymentAccounts.label],
          set: {
            publicKeyId,
            sealedCredentials,
            sealedWebhookSecret,
            credentialFingerprint: fingerprint,
            isEnabled: input.isEnabled,
            // New credentials are unverified by definition.
            lastVerifiedAt: null,
            lastError: null,
            updatedAt: new Date(),
            updatedByUserId: ctx.actorUserId,
          },
        })
        .returning(VIEW_COLUMNS);

      // Audit carries fingerprints and flags ONLY — never secret material.
      await recordAudit(tx, ctx.tenantId, {
        actorType: "staff",
        actorUserId: ctx.actorUserId,
        action: "payments.account_updated",
        entityType: "payment_account",
        entityId: row!.id,
        before: existing
          ? {
              providerCode: existing.providerCode,
              publicKeyId: existing.publicKeyId,
              credentialFingerprint: existing.credentialFingerprint,
              isEnabled: existing.isEnabled,
            }
          : null,
        after: {
          providerCode: input.providerCode,
          publicKeyId,
          credentialFingerprint: fingerprint,
          isEnabled: input.isEnabled,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return row!;
    });
  } catch (err) {
    const pg = pgError(err);
    // Two concurrent enables slipped past the same-tx disable — retryable.
    if (pg.code === "23505" && pg.text.includes("payment_accounts_one_enabled_key")) {
      throw new AppError({
        code: "concurrent_modification",
        message: "Another payment account was enabled concurrently",
        status: 409,
        publicMessage: "Another gateway was enabled at the same time. Please retry.",
      });
    }
    throw err;
  }
}

/**
 * The console's read: fingerprint only, secrets never leave the row.
 * Phase 2 shows one gateway — the enabled account wins, else the most
 * recently touched one.
 */
export async function getPaymentAccountView(
  tenantId: string,
): Promise<PaymentAccountView | null> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select(VIEW_COLUMNS)
      .from(paymentAccounts)
      .where(eq(paymentAccounts.tenantId, tenantId))
      .orderBy(desc(paymentAccounts.isEnabled), desc(paymentAccounts.updatedAt))
      .limit(1),
  );
  return row ?? null;
}

/** Sealed row for server-side use; unseal helpers below are the only readers. */
export type EnabledPaymentAccount = {
  id: string;
  providerCode: PaymentProviderCode;
  label: string;
  publicKeyId: string;
  sealedCredentials: string;
  sealedWebhookSecret: string;
};

/** The single enabled gateway (payment_accounts_one_enabled_key), or null. */
export async function getEnabledAccount(
  tx: Tx,
  tenantId: string,
): Promise<EnabledPaymentAccount | null> {
  const [row] = await tx
    .select({
      id: paymentAccounts.id,
      providerCode: paymentAccounts.providerCode,
      label: paymentAccounts.label,
      publicKeyId: paymentAccounts.publicKeyId,
      sealedCredentials: paymentAccounts.sealedCredentials,
      sealedWebhookSecret: paymentAccounts.sealedWebhookSecret,
    })
    .from(paymentAccounts)
    .where(and(eq(paymentAccounts.tenantId, tenantId), eq(paymentAccounts.isEnabled, true)))
    .limit(1);
  return row ?? null;
}

/** Unseals the API-key blob. NEVER called from the webhook route (D7). */
export async function unsealGatewayCredentials(
  tenantId: string,
  account: Pick<EnabledPaymentAccount, "providerCode" | "sealedCredentials">,
): Promise<GatewayCredentials> {
  const opened = openCredentials<{ keyId?: unknown; keySecret?: unknown }>(
    account.sealedCredentials,
    paymentCredentialsAad(tenantId, account.providerCode),
  );
  if (typeof opened.keyId !== "string" || typeof opened.keySecret !== "string") {
    // Authenticated but not credentials-shaped: a foreign blob written by
    // hand. Same generic refusal as a failed unseal — nothing to learn.
    throw new EnvelopeError("Credential envelope does not contain gateway credentials");
  }
  return { keyId: opened.keyId, keySecret: opened.keySecret };
}

/** Webhook-route-only helper: unseals ONLY the HMAC secret (D7). */
export async function unsealWebhookSecret(
  tenantId: string,
  account: Pick<EnabledPaymentAccount, "providerCode" | "sealedWebhookSecret">,
): Promise<string> {
  const opened = openCredentials<{ webhookSecret?: unknown }>(
    account.sealedWebhookSecret,
    paymentWebhookSecretAad(tenantId, account.providerCode),
  );
  if (typeof opened.webhookSecret !== "string" || opened.webhookSecret.length === 0) {
    throw new EnvelopeError("Webhook envelope does not contain a webhook secret");
  }
  return opened.webhookSecret;
}

/**
 * TX-1 of the webhook flow: its OWN small transaction inserting the raw
 * evidence row. duplicate=true on 23505 of pwe_gateway_event_key — the
 * caller re-runs processing idempotently and returns 200.
 */
export async function recordWebhookEvent(
  ctx: BuyerContext,
  input: {
    providerCode: PaymentProviderCode;
    gatewayEventId: string;
    eventType: string;
    orderId?: string | null;
    paymentId?: string | null;
    rawPayload: unknown;
  },
): Promise<{ webhookEventId: string; duplicate: boolean }> {
  if (!input.gatewayEventId || !input.eventType) {
    refuse("invalid_payload", "gatewayEventId", "Webhook events need a gateway event id and type.");
  }
  try {
    return await withTenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(paymentWebhookEvents)
        .values({
          tenantId: ctx.tenantId,
          providerCode: input.providerCode,
          gatewayEventId: input.gatewayEventId,
          eventType: input.eventType,
          orderId: input.orderId ?? null,
          paymentId: input.paymentId ?? null,
          rawPayload: input.rawPayload,
        })
        .returning({ id: paymentWebhookEvents.id });
      return { webhookEventId: row!.id, duplicate: false };
    });
  } catch (err) {
    const pg = pgError(err);
    // THE dedupe gate: the unique constraint IS the idempotency check.
    // The evidence row already committed on a previous delivery — return
    // it so the caller re-runs processing idempotently.
    if (pg.code === "23505" && pg.text.includes("pwe_gateway_event_key")) {
      const [existing] = await withTenant(ctx.tenantId, (tx) =>
        tx
          .select({ id: paymentWebhookEvents.id })
          .from(paymentWebhookEvents)
          .where(
            and(
              eq(paymentWebhookEvents.tenantId, ctx.tenantId),
              eq(paymentWebhookEvents.providerCode, input.providerCode),
              eq(paymentWebhookEvents.gatewayEventId, input.gatewayEventId),
            ),
          )
          .limit(1),
      );
      if (existing) return { webhookEventId: existing.id, duplicate: true };
    }
    throw err;
  }
}

/** INSERT the payments row ('created') inside the CALLER's tx (§4.2 TX-D). */
export async function insertPayment(
  tx: Tx,
  tenantId: string,
  input: {
    orderId: string;
    paymentAccountId: string;
    providerCode: PaymentProviderCode;
    amountPaise: number;
    currency?: string;
    gatewayOrderId: string;
  },
): Promise<{ paymentId: string }> {
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
    refuse("invalid_payload", "amountPaise", "Payment amount must be a positive integer in paise.");
  }
  const [row] = await tx
    .insert(payments)
    .values({
      tenantId,
      orderId: input.orderId,
      paymentAccountId: input.paymentAccountId,
      providerCode: input.providerCode,
      status: "created",
      amountPaise: input.amountPaise,
      currency: input.currency ?? "INR",
      gatewayOrderId: input.gatewayOrderId,
    })
    .returning({ id: payments.id });
  return { paymentId: row!.id };
}

/** Marks captured + records gateway ids and fee economics (D17), in the caller's tx. */
export async function markPaymentCaptured(
  tx: Tx,
  tenantId: string,
  input: {
    paymentId: string;
    gatewayPaymentId: string;
    method?: string | null;
    feePaise?: number | null;
    feeTaxPaise?: number | null;
    capturedAt?: Date;
  },
): Promise<void> {
  const [row] = await tx
    .update(payments)
    .set({
      status: "captured",
      gatewayPaymentId: input.gatewayPaymentId,
      method: input.method ?? null,
      // Settlement economics from the webhook payload (D17); null when
      // the gateway did not report them.
      feePaise: input.feePaise ?? null,
      feeTaxPaise: input.feeTaxPaise ?? null,
      capturedAt: input.capturedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(payments.tenantId, tenantId), eq(payments.id, input.paymentId)))
    .returning({ id: payments.id });
  if (!row) {
    throw new AppError({
      code: "not_found",
      message: `Payment ${input.paymentId} not found in tenant ${tenantId}`,
      status: 404,
      publicMessage: "That payment does not exist.",
    });
  }
}

export async function markPaymentFailed(
  tx: Tx,
  tenantId: string,
  input: { paymentId: string; errorCode?: string | null; errorDescription?: string | null },
): Promise<void> {
  const [row] = await tx
    .update(payments)
    .set({
      status: "failed",
      errorCode: input.errorCode ?? null,
      errorDescription: input.errorDescription ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(payments.tenantId, tenantId), eq(payments.id, input.paymentId)))
    .returning({ id: payments.id });
  if (!row) {
    throw new AppError({
      code: "not_found",
      message: `Payment ${input.paymentId} not found in tenant ${tenantId}`,
      status: 404,
      publicMessage: "That payment does not exist.",
    });
  }
}

/**
 * Insert-once refund intent in the CALLER's tx (D6): the
 * refunds_payment_key UNIQUE resolves double-cancel and webhook-retry
 * races — on conflict the existing row is returned with created=false.
 *
 * Implemented as INSERT .. ON CONFLICT DO NOTHING rather than a caught
 * 23505: a raised 23505 would abort the CALLER's whole transaction, and
 * this contract must be deliverable from inside it. The observable
 * mapping is identical — the constraint decides, never an app-side
 * status check — and a concurrent racer blocks on the unique index until
 * the winner commits, then reads the winner's row.
 */
export async function createRefundIntent(
  tx: Tx,
  tenantId: string,
  input: {
    orderId: string;
    paymentId: string;
    amountPaise: number;
    reason: RefundReason;
    createdByUserId?: string | null;
  },
): Promise<{ refundId: string; created: boolean }> {
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
    refuse("invalid_payload", "amountPaise", "Refund amount must be a positive integer in paise.");
  }
  if (!REFUND_REASONS.includes(input.reason)) {
    refuse("invalid_payload", "reason", "Unknown refund reason.");
  }

  const [inserted] = await tx
    .insert(refunds)
    .values({
      tenantId,
      orderId: input.orderId,
      paymentId: input.paymentId,
      amountPaise: input.amountPaise,
      status: "pending",
      reason: input.reason,
      createdByUserId: input.createdByUserId ?? null,
    })
    .onConflictDoNothing({ target: [refunds.tenantId, refunds.paymentId] })
    .returning({ id: refunds.id });
  if (inserted) return { refundId: inserted.id, created: true };

  const [existing] = await tx
    .select({ id: refunds.id })
    .from(refunds)
    .where(and(eq(refunds.tenantId, tenantId), eq(refunds.paymentId, input.paymentId)))
    .limit(1);
  if (!existing) {
    // DO NOTHING with no visible winner should be impossible in READ
    // COMMITTED — each statement takes a fresh snapshot.
    throw new Error(`Refund for payment ${input.paymentId} neither inserted nor found`);
  }
  return { refundId: existing.id, created: false };
}

/** What the gateway-refund worker needs to call the adapter. */
export type RefundJobView = {
  refundId: string;
  orderId: string;
  paymentId: string;
  amountPaise: number;
  status: string;
  gatewayPaymentId: string | null;
  gatewayRefundId: string | null;
  account: EnabledPaymentAccount | null;
};

export async function getRefundForProcessing(
  tenantId: string,
  refundId: string,
): Promise<RefundJobView | null> {
  return withTenant(tenantId, async (tx) => {
    const [refund] = await tx
      .select({
        id: refunds.id,
        orderId: refunds.orderId,
        paymentId: refunds.paymentId,
        amountPaise: refunds.amountPaise,
        status: refunds.status,
        gatewayRefundId: refunds.gatewayRefundId,
      })
      .from(refunds)
      .where(and(eq(refunds.tenantId, tenantId), eq(refunds.id, refundId)))
      .limit(1);
    if (!refund) return null;

    // payment_id is a bare uuid (financial history ruling) — resolve it
    // with an explicit tenant-scoped SELECT, never a join through an FK.
    const [payment] = await tx
      .select({ gatewayPaymentId: payments.gatewayPaymentId })
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, refund.paymentId)))
      .limit(1);

    return {
      refundId: refund.id,
      orderId: refund.orderId,
      paymentId: refund.paymentId,
      amountPaise: refund.amountPaise,
      status: refund.status,
      gatewayPaymentId: payment?.gatewayPaymentId ?? null,
      gatewayRefundId: refund.gatewayRefundId,
      account: await getEnabledAccount(tx, tenantId),
    };
  });
}

/**
 * Worker marks the intent 'processing' after the adapter accepts it.
 * Idempotent: only a 'pending' row moves, so a retried job (or one
 * racing the refund.processed webhook) updates zero rows and no-ops.
 */
export async function markRefundProcessing(
  tenantId: string,
  input: { refundId: string; gatewayRefundId: string },
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx
      .update(refunds)
      .set({
        status: "processing",
        gatewayRefundId: input.gatewayRefundId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(refunds.tenantId, tenantId),
          eq(refunds.id, input.refundId),
          eq(refunds.status, "pending"),
        ),
      ),
  );
}

/**
 * Terminal transition driven by the refund.processed webhook, inside the
 * CALLER's processing tx. Returns the affected refund/order pair so the
 * caller can advance order payment_status and write the event row; null
 * when no non-terminal refund carries that gateway id (unknown id, or a
 * replayed webhook after the transition already landed) — the caller
 * then advances nothing, which is the idempotence.
 */
export async function markRefundProcessed(
  tx: Tx,
  tenantId: string,
  input: { gatewayRefundId: string },
): Promise<{ refundId: string; orderId: string } | null> {
  const [row] = await tx
    .update(refunds)
    .set({ status: "processed", updatedAt: new Date() })
    .where(
      and(
        eq(refunds.tenantId, tenantId),
        eq(refunds.gatewayRefundId, input.gatewayRefundId),
        inArray(refunds.status, ["pending", "processing"]),
      ),
    )
    .returning({ refundId: refunds.id, orderId: refunds.orderId });
  return row ?? null;
}
