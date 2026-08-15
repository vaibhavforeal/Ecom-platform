import { PAYMENT_PROVIDER_CODES, PAYMENT_STATUSES, REFUND_STATUSES } from "@platform/db/schema";
import type { PaymentProviderCode, PaymentStatus, RefundStatus } from "@platform/db/schema";

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

/**
 * Splits an order total by payment mode. Invariant: advance + codDue ===
 * total EXACTLY. Advance rounds HALF_UP from bps, clamped to
 * [minAdvance, total]; cod → advance 0; disabled modes throw 422.
 */
export function computeAdvanceSplit(
  _totalPaise: number,
  _policy: AdvancePolicy,
  _mode: "prepaid" | "cod" | "cod_advance",
): { advancePaise: number; codDuePaise: number } {
  throw new Error("S0 stub: implemented by lot B3");
}
