import type { PromotionStatus, Tx } from "@platform/db";

import type { WriteContext } from "../catalog/writes";
import type { Condition, Effect, PromotionData } from "./index";

/**
 * Promotions — SERVER barrel. S0 SCHEMA SPINE: signatures FROZEN; bodies
 * implemented by lot B2.
 *
 * Locked rules: limits are enforced by the coupon_redemptions unique
 * constraints, NEVER a counter; the promotion row is SELECTed FOR UPDATE
 * before any slot computation (D8); pending-claim counting keeps the
 * `expires_at > now()` read-side filter exactly like holds; 23505 on the
 * slot indexes maps to 409 `concurrent_modification`.
 */

export type PromotionInput = {
  /** Uppercased at write; /^[A-Z0-9_-]{3,40}$/i at the route. */
  code: string;
  name: string;
  status: PromotionStatus;
  startsAt?: Date | null;
  endsAt?: Date | null;
  /** zod-validated (conditionSchema/effectSchema) before write. */
  conditions: Condition[];
  effects: Effect[];
  usageLimitTotal?: number | null;
  usageLimitPerCustomer?: number | null;
};

export async function createPromotion(
  _ctx: WriteContext,
  _input: PromotionInput,
): Promise<PromotionData> {
  throw new Error("S0 stub: implemented by lot B2");
}

export async function updatePromotion(
  _ctx: WriteContext,
  _promotionId: string,
  _input: PromotionInput,
): Promise<PromotionData> {
  throw new Error("S0 stub: implemented by lot B2");
}

/** DELETE archives — promotions referenced by orders are never erased. */
export async function archivePromotion(_ctx: WriteContext, _promotionId: string): Promise<void> {
  throw new Error("S0 stub: implemented by lot B2");
}

export async function listPromotions(
  _tenantId: string,
  _opts: { status?: PromotionStatus; limit?: number; offset?: number } = {},
): Promise<{ items: PromotionData[]; total: number }> {
  throw new Error("S0 stub: implemented by lot B2");
}

export async function getPromotion(
  _tenantId: string,
  _promotionId: string,
): Promise<PromotionData | null> {
  throw new Error("S0 stub: implemented by lot B2");
}

/**
 * SELECT .. FOR UPDATE by uppercased code, status='active' (D8): the
 * lock serializes BOTH the checkout-start advisory count and the confirm
 * slot computation. Null when absent/inactive.
 */
export async function loadActivePromotionForUpdate(
  _tx: Tx,
  _tenantId: string,
  _code: string,
): Promise<PromotionData | null> {
  throw new Error("S0 stub: implemented by lot B2");
}

/**
 * Slot mechanics inside the CALLER's confirming tx (§1.8): with the
 * promotion row already locked, slot = COUNT(*) rows, customer_slot =
 * COUNT(*) for (promotion, customer); at a limit → {claimed:false} —
 * the CALLER decides between 422 coupon_exhausted (checkout) and
 * confirm-anyway + `promotion.overredeemed` (captured money, §4.4.h).
 * A racer past the count collides on the unique index → 23505 → 409.
 */
export async function claimRedemption(
  _tx: Tx,
  _tenantId: string,
  _input: {
    promotion: PromotionData;
    orderId: string;
    customerId: string | null;
    discountPaise: number;
  },
): Promise<
  | { claimed: true; redemptionId: string; slot: number; customerSlot: number }
  | { claimed: false; reason: "coupon_exhausted" }
> {
  throw new Error("S0 stub: implemented by lot B2");
}

/**
 * Advisory pending-claim count for checkout-start (D8): pending_payment
 * orders carrying this promotion_id with expires_at > now() — the
 * read-side expiry filter is NON-NEGOTIABLE.
 */
export async function countPendingClaims(
  _tx: Tx,
  _tenantId: string,
  _promotionId: string,
): Promise<number> {
  throw new Error("S0 stub: implemented by lot B2");
}
