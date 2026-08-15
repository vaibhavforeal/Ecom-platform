import type { PaymentProviderCode, Tx } from "@platform/db";

import type { WriteContext } from "../catalog/writes";
import type { BuyerContext } from "../cart/index";
import type { GatewayCredentials, RefundReason } from "./index";

/**
 * Payments — SERVER barrel. S0 SCHEMA SPINE: signatures FROZEN; bodies
 * implemented by lot B3.
 *
 * Locked rules: TWO sealed envelope blobs per account (D7) with AAD
 * bound to (tenant_id, provider_code); the webhook route unseals ONLY
 * the webhook secret; secrets are never echoed (fingerprint only);
 * webhook idempotency is the pwe_gateway_event_key unique constraint,
 * never an app-side check; refunds are insert-once rows (D6).
 */

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

export async function upsertPaymentAccount(
  _ctx: WriteContext,
  _input: UpsertPaymentAccountInput,
): Promise<PaymentAccountView> {
  throw new Error("S0 stub: implemented by lot B3");
}

export async function getPaymentAccountView(
  _tenantId: string,
): Promise<PaymentAccountView | null> {
  throw new Error("S0 stub: implemented by lot B3");
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
  _tx: Tx,
  _tenantId: string,
): Promise<EnabledPaymentAccount | null> {
  throw new Error("S0 stub: implemented by lot B3");
}

/** Unseals the API-key blob. NEVER called from the webhook route (D7). */
export async function unsealGatewayCredentials(
  _tenantId: string,
  _account: Pick<EnabledPaymentAccount, "providerCode" | "sealedCredentials">,
): Promise<GatewayCredentials> {
  throw new Error("S0 stub: implemented by lot B3");
}

/** Webhook-route-only helper: unseals ONLY the HMAC secret (D7). */
export async function unsealWebhookSecret(
  _tenantId: string,
  _account: Pick<EnabledPaymentAccount, "providerCode" | "sealedWebhookSecret">,
): Promise<string> {
  throw new Error("S0 stub: implemented by lot B3");
}

/**
 * TX-1 of the webhook flow: its OWN small transaction inserting the raw
 * evidence row. duplicate=true on 23505 of pwe_gateway_event_key — the
 * caller re-runs processing idempotently and returns 200.
 */
export async function recordWebhookEvent(
  _ctx: BuyerContext,
  _input: {
    providerCode: PaymentProviderCode;
    gatewayEventId: string;
    eventType: string;
    orderId?: string | null;
    paymentId?: string | null;
    rawPayload: unknown;
  },
): Promise<{ webhookEventId: string; duplicate: boolean }> {
  throw new Error("S0 stub: implemented by lot B3");
}

/** INSERT the payments row ('created') inside the CALLER's tx (§4.2 TX-D). */
export async function insertPayment(
  _tx: Tx,
  _tenantId: string,
  _input: {
    orderId: string;
    paymentAccountId: string;
    providerCode: PaymentProviderCode;
    amountPaise: number;
    currency?: string;
    gatewayOrderId: string;
  },
): Promise<{ paymentId: string }> {
  throw new Error("S0 stub: implemented by lot B3");
}

/** Marks captured + records gateway ids and fee economics (D17), in the caller's tx. */
export async function markPaymentCaptured(
  _tx: Tx,
  _tenantId: string,
  _input: {
    paymentId: string;
    gatewayPaymentId: string;
    method?: string | null;
    feePaise?: number | null;
    feeTaxPaise?: number | null;
    capturedAt?: Date;
  },
): Promise<void> {
  throw new Error("S0 stub: implemented by lot B3");
}

export async function markPaymentFailed(
  _tx: Tx,
  _tenantId: string,
  _input: { paymentId: string; errorCode?: string | null; errorDescription?: string | null },
): Promise<void> {
  throw new Error("S0 stub: implemented by lot B3");
}

/**
 * Insert-once refund intent in the CALLER's tx (D6): the
 * refunds_payment_key UNIQUE resolves double-cancel and webhook-retry
 * races — on conflict the existing row is returned with created=false.
 */
export async function createRefundIntent(
  _tx: Tx,
  _tenantId: string,
  _input: {
    orderId: string;
    paymentId: string;
    amountPaise: number;
    reason: RefundReason;
    createdByUserId?: string | null;
  },
): Promise<{ refundId: string; created: boolean }> {
  throw new Error("S0 stub: implemented by lot B3");
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
  _tenantId: string,
  _refundId: string,
): Promise<RefundJobView | null> {
  throw new Error("S0 stub: implemented by lot B3");
}

/** Worker marks the intent 'processing' after the adapter accepts it. */
export async function markRefundProcessing(
  _tenantId: string,
  _input: { refundId: string; gatewayRefundId: string },
): Promise<void> {
  throw new Error("S0 stub: implemented by lot B3");
}

/**
 * Terminal transition driven by the refund.processed webhook, inside the
 * CALLER's processing tx. Returns the affected refund/order pair so the
 * caller can advance order payment_status and write the event row.
 */
export async function markRefundProcessed(
  _tx: Tx,
  _tenantId: string,
  _input: { gatewayRefundId: string },
): Promise<{ refundId: string; orderId: string } | null> {
  throw new Error("S0 stub: implemented by lot B3");
}
