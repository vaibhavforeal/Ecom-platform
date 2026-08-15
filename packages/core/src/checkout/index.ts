import { z } from "zod";

import { CHECKOUT_PAYMENT_MODES } from "@platform/db/schema";
import type { CheckoutPaymentMode } from "@platform/db/schema";

import { PINCODE_RE } from "../serviceability/index";

/**
 * Checkout — PURE barrel, safe for client bundles (the B4 checkout page
 * ships against these payload/response types).
 *
 * S0 SCHEMA SPINE: types and signatures FROZEN (§6.5, §7); zod internals
 * and bodies implemented by lot B-INT.
 *
 * CLIENT-SAFETY NOTE: this module is bundled into the checkout form's
 * client build, so it must not import `node:crypto` (Next does not
 * polyfill node builtins client-side). The fingerprint therefore uses
 * the small pure-TS SHA-256 below, pinned against node:crypto in
 * checkout-fingerprint.test.ts so the two can never disagree.
 */

export { CHECKOUT_PAYMENT_MODES };
export type { CheckoutPaymentMode };

export { PINCODE_RE };

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

/** Same regex as users/customers phone CHECKs. */
const E164_RE = /^\+[1-9][0-9]{7,14}$/;
/** Standard 15-character GSTIN shape (state code + PAN + entity + Z + checksum). */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
/** GST state codes are two digits ('07', '29', …). */
const STATE_CODE_RE = /^[0-9]{2}$/;

/** zod schema for the payload above — the route's single parse. */
export const checkoutPayloadSchema: z.ZodType<CheckoutPayload> = z.object({
  idempotencyKey: z
    .string()
    .min(8, "Idempotency key must be 8–64 characters.")
    .max(64, "Idempotency key must be 8–64 characters."),
  buyerName: z.string().trim().min(1, "Enter a name.").max(120, "Name is too long."),
  phone: z.string().trim().regex(E164_RE, "Enter a valid phone number (+91…)."),
  email: z
    .string()
    .trim()
    .email("Enter a valid email address.")
    .max(200, "Email is too long.")
    .nullish(),
  shippingAddress: z.object({
    line1: z.string().trim().min(1, "Enter an address.").max(200, "Address line is too long."),
    line2: z.string().trim().max(200, "Address line is too long.").nullish(),
    city: z.string().trim().min(1, "Enter a city.").max(100, "City is too long."),
    stateCode: z.string().trim().regex(STATE_CODE_RE, "Select a state."),
    pincode: z.string().trim().regex(PINCODE_RE, "Enter a valid 6-digit pincode."),
  }),
  buyerGstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(GSTIN_RE, "Enter a valid 15-character GSTIN.")
    .nullish(),
  couponCode: z.string().trim().max(40, "Coupon codes are at most 40 characters.").nullish(),
  paymentMode: z.enum(CHECKOUT_PAYMENT_MODES),
});

/**
 * sha256 hex over the canonical JSON (§6.5): lines sorted by variantId;
 * couponCode null/absent/'' canonicalized; coupon and state
 * case-normalized. Line order must not affect the hash. Reusing an
 * idempotency key with a different fingerprint is 422
 * `idempotency_key_reuse`.
 */
export function computeCheckoutFingerprint(input: {
  lines: { variantId: string; quantity: number }[];
  pincode: string;
  stateCode: string;
  paymentMode: string;
  couponCode: string | null;
  buyerPhone: string;
}): string {
  const coupon = input.couponCode?.trim().toUpperCase() || null; // '' and absent → null
  const canonical = JSON.stringify({
    lines: [...input.lines]
      .sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0))
      .map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    pincode: input.pincode.trim(),
    stateCode: input.stateCode.trim().toUpperCase(),
    paymentMode: input.paymentMode,
    couponCode: coupon,
    buyerPhone: input.buyerPhone.trim(),
  });
  return sha256Hex(canonical);
}

// ─────────────────────────────────────────────────────────────────────
// SHA-256 (FIPS 180-4), pure TS — see the client-safety note up top.
// Verified against node:crypto in checkout-fingerprint.test.ts.
// ─────────────────────────────────────────────────────────────────────

// prettier-ignore
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256Hex(message: string): string {
  const data = new TextEncoder().encode(message);
  const bitLength = data.length * 8;
  // room for the mandatory 0x80 byte plus the 8-byte big-endian length
  const paddedLength = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
    0x5be0cd19,
  ];
  const w = new Array<number>(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

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
