import { PAYMENT_PROVIDER_CODES, PAYMENT_STATUSES, REFUND_STATUSES } from "@platform/db/schema";
import type { PaymentProviderCode, PaymentStatus, RefundStatus } from "@platform/db/schema";

import { AppError } from "../errors";

/**
 * Payments — PURE barrel, safe for client bundles (the settings page and
 * checkout hand-off import these). Values come from `@platform/db/schema`
 * (no postgres driver); the root `@platform/db` barrel must never be
 * imported here.
 *
 * S0 SCHEMA SPINE: signatures and the adapter contract FROZEN
 * (PHASE2_COMMERCE_DESIGN.md §4.5, §6.2); bodies implemented by lot B3.
 */

export { PAYMENT_PROVIDER_CODES, PAYMENT_STATUSES, REFUND_STATUSES };
export type { PaymentProviderCode, PaymentStatus, RefundStatus };

/** Why a refund intent exists (refunds.reason). */
export const REFUND_REASONS = [
  "merchant_cancelled",
  "stock_shortfall",
  "late_capture_abandoned",
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/** store_settings keys — defined once so reader and writer cannot drift. */
export const PAYMENT_SETTINGS_KEYS = {
  codEnabled: "payments.cod_enabled",
  advanceBps: "payments.advance_bps",
  minAdvancePaise: "payments.min_advance_paise",
} as const;

/** Unsealed per-tenant gateway API credentials. Never logged, never returned. */
export type GatewayCredentials = { keyId: string; keySecret: string };

/** Gateway event types this platform acts on; parseWebhook may report others. */
export const GATEWAY_EVENT_TYPES = [
  "payment.captured",
  "payment.failed",
  "refund.processed",
] as const;
export type GatewayKnownEventType = (typeof GATEWAY_EVENT_TYPES)[number];

/** Normalized webhook payload, produced by an adapter's parseWebhook. */
export type GatewayEvent = {
  /** x-razorpay-event-id (or mock equivalent) — THE idempotency key. */
  eventId: string;
  /** One of GATEWAY_EVENT_TYPES, or a pass-through unknown type. */
  type: string;
  gatewayOrderId: string;
  gatewayPaymentId?: string;
  gatewayRefundId?: string;
  amountPaise: number;
  /** upi | card | netbanking … as reported. */
  method?: string;
  /** Settlement economics from the payload (D17). */
  feePaise?: number;
  feeTaxPaise?: number;
  error?: { code?: string; description?: string };
};

/**
 * The Razorpay-shaped BYOG adapter contract (locked decision).
 * Implementations live in @platform/integrations; the registry's
 * real-vs-mock gate fails CLOSED on unset NODE_ENV (fake-carrier
 * precedent). verifyWebhook is HMAC-SHA256 over the RAW body with
 * timingSafeEqual — and it runs BEFORE any other work.
 */
export interface PaymentGatewayAdapter {
  readonly provider: PaymentProviderCode;
  createGatewayOrder(
    creds: GatewayCredentials,
    args: { amountPaise: number; currency: string; receipt: string },
  ): Promise<{ gatewayOrderId: string }>;
  verifyWebhook(webhookSecret: string, args: { rawBody: string; signature: string }): boolean;
  parseWebhook(rawBody: string): GatewayEvent;
  refund(
    creds: GatewayCredentials,
    args: { gatewayPaymentId: string; amountPaise: number; idempotencyKey: string },
  ): Promise<{ gatewayRefundId: string }>;
}

/** store_settings-backed partial-payment policy (§6.2). */
export type AdvancePolicy = {
  codEnabled: boolean;
  /** 2000 = 20%; null = partial mode unavailable. */
  advanceBps: number | null;
  /** Floor. */
  minAdvancePaise: number;
};

/** 422 with the field-level shape every form renderer already understands. */
function refuseSplit(code: string, path: string, message: string): never {
  throw new AppError({
    code,
    message: `computeAdvanceSplit refused: ${message}`,
    status: 422,
    publicMessage: "Some fields need attention.",
    details: { issues: [{ path, message }] },
  });
}

/**
 * Splits an order total by payment mode. Invariant: advance + codDue ===
 * total EXACTLY. Advance rounds HALF_UP from bps, clamped to
 * [minAdvance, total]; cod → advance 0; disabled modes throw 422.
 */
export function computeAdvanceSplit(
  totalPaise: number,
  policy: AdvancePolicy,
  mode: "prepaid" | "cod" | "cod_advance",
): { advancePaise: number; codDuePaise: number } {
  // Integer paise only, and small enough that `total × bps` stays exact —
  // the bps product is the one place float drift could mint a paisa.
  if (
    !Number.isSafeInteger(totalPaise) ||
    totalPaise < 0 ||
    totalPaise > Number.MAX_SAFE_INTEGER / 10_000
  ) {
    refuseSplit("invalid_payload", "totalPaise", "Order total must be a non-negative integer amount in paise.");
  }

  if (mode === "prepaid") {
    // Fully paid online; zero-total orders pass through as 0/0 (§4.2.6 —
    // the gateway is skipped entirely for them).
    return { advancePaise: totalPaise, codDuePaise: 0 };
  }

  if (!policy.codEnabled) {
    refuseSplit("invalid_payload", "paymentMode", "Cash on delivery is not available on this store.");
  }

  if (mode === "cod") {
    return { advancePaise: 0, codDuePaise: totalPaise };
  }

  // mode === "cod_advance"
  if (policy.advanceBps === null) {
    refuseSplit("advance_not_configured", "paymentMode", "Partial advance payment is not configured on this store.");
  }
  if (!Number.isInteger(policy.advanceBps) || policy.advanceBps < 0 || policy.advanceBps > 10_000) {
    refuseSplit("invalid_payload", "paymentMode", "The advance percentage is misconfigured.");
  }
  if (!Number.isSafeInteger(policy.minAdvancePaise) || policy.minAdvancePaise < 0) {
    refuseSplit("invalid_payload", "paymentMode", "The minimum advance amount is misconfigured.");
  }

  // HALF_UP from bps in pure integer math (never float division), then
  // clamp to [minAdvance, total]. minAdvance > total collapses to a fully
  // prepaid order (advance = total, codDue = 0); a zero-total order stays
  // 0/0 because the upper clamp wins.
  const rawAdvance = Math.floor((totalPaise * policy.advanceBps + 5_000) / 10_000);
  const advancePaise = Math.min(Math.max(rawAdvance, policy.minAdvancePaise), totalPaise);
  const codDuePaise = totalPaise - advancePaise;

  // The frozen invariant, asserted rather than assumed: a split that does
  // not sum back to the total is a money bug, not a validation failure.
  if (advancePaise + codDuePaise !== totalPaise) {
    throw new Error(
      `computeAdvanceSplit invariant broken: ${advancePaise} + ${codDuePaise} !== ${totalPaise}`,
    );
  }
  return { advancePaise, codDuePaise };
}
