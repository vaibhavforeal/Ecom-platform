import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Guest order-status tokens (spec §7): `/order/[id]?t=<hmac>`.
 *
 * There is no buyer login in Phase 2, so possession of this token IS the
 * authorisation to read one order. It is an HMAC-SHA256 of the order id
 * keyed by SESSION_SECRET — deterministic (the same order always has the
 * same URL, so a buyer can bookmark it), unforgeable without the secret,
 * and scoped to exactly one order id.
 *
 * B-INT's startCheckout builds the `orderToken` in CheckoutStartResponse
 * with `signOrderToken` from here — one derivation, shared by signer and
 * verifier, cannot drift.
 */

const TOKEN_CONTEXT = "order-status";

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET must be set to sign order tokens");
  return value;
}

export function signOrderToken(orderId: string): string {
  return createHmac("sha256", secret()).update(`${TOKEN_CONTEXT}:${orderId}`).digest("base64url");
}

/**
 * Constant-time verification. The length gate leaks only the token
 * FORMAT (fixed for HMAC-SHA256/base64url), never which bytes matched —
 * timingSafeEqual requires equal lengths and does the rest.
 */
export function verifyOrderToken(orderId: string, token: string | null | undefined): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const expected = Buffer.from(signOrderToken(orderId), "utf8");
  const provided = Buffer.from(token, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
