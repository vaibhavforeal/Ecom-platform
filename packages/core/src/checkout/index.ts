import { z } from "zod";

import { CHECKOUT_PAYMENT_MODES } from "@platform/db/schema";
import type { CheckoutPaymentMode } from "@platform/db/schema";

/**
 * Checkout — PURE barrel, safe for client bundles (the B4 checkout page
 * ships against these payload/response types).
 *
 * S0 SCHEMA SPINE: types and signatures FROZEN (§6.5, §7); zod internals
 * and bodies implemented by lot B-INT.
 */

export { CHECKOUT_PAYMENT_MODES };
export type { CheckoutPaymentMode };

export { PINCODE_RE } from "../serviceability/index";

/** Snapshot shape stored on carts/orders ({line1,line2?,city,state_code,pincode}). */
export type ShippingAddress = {
  line1: string;
  line2?: string | null;
  city: string;
  /** 2-char GST state code, cross-checked against the pincode prefix (D3). */
  stateCode: string;
  pincode: string;
};

/** POST /api/checkout body (§7). */
export type CheckoutPayload = {
  /** Client-supplied, 8..64 chars — the PRIMARY idempotency key (D1a). */
  idempotencyKey: string;
  buyerName: string;
  /** E.164. */
  phone: string;
  email?: string | null;
  shippingAddress: ShippingAddress;
  /** GSTIN regex-checked when present (B2B buyer). */
  buyerGstin?: string | null;
  couponCode?: string | null;
  paymentMode: CheckoutPaymentMode;
};

/** zod schema for the payload above — the route's single parse. */
export const checkoutPayloadSchema: z.ZodType<CheckoutPayload> = z.custom<CheckoutPayload>(
  () => {
    throw new Error("S0 stub: implemented by lot B-INT");
  },
);

/**
 * startCheckout's response: COD and zero-total orders confirm in the
 * request (D5); prepaid/cod_advance hand off to the gateway. orderToken
 * is the HMAC guest-order-page token.
 */
export type CheckoutStartResponse =
  | { orderId: string; orderToken: string; status: "confirmed" }
  | {
      orderId: string;
      orderToken: string;
      status: "payment_required";
      gatewayOrderId: string;
      publicKeyId: string;
      amountPaise: number;
    };

/**
 * sha256 hex over the canonical JSON (§6.5): lines sorted by variantId;
 * couponCode null/absent/'' canonicalized; coupon and state
 * case-normalized. Line order must not affect the hash. Reusing an
 * idempotency key with a different fingerprint is 422
 * `idempotency_key_reuse`.
 */
export function computeCheckoutFingerprint(_input: {
  lines: { variantId: string; quantity: number }[];
  pincode: string;
  stateCode: string;
  paymentMode: string;
  couponCode: string | null;
  buyerPhone: string;
}): string {
  throw new Error("S0 stub: implemented by lot B-INT");
}
