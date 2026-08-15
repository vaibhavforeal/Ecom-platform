import { z } from "zod";

import { PROMOTION_STATUSES } from "@platform/db/schema";
import type { OrderChannel, PromotionStatus } from "@platform/db/schema";

/**
 * Promotions — PURE barrel, safe for client bundles (the console
 * promotion builder imports the Condition/Effect types). Rules are DATA
 * (blueprint §4.4): the FULL vocabulary ships now, including
 * `buy_x_get_y` and `customer_segment` — the latter evaluates to
 * {applicable:false, reason:'unsupported_condition'} until segments
 * exist (Phase 4): reserved-but-honest, never a silent pass.
 *
 * S0 SCHEMA SPINE: types and signatures FROZEN (§6.3); bodies and zod
 * internals implemented by lot B2. 100% branch coverage expected —
 * discount bugs cost money.
 */

export { PROMOTION_STATUSES };
export type { PromotionStatus };

/** Conditions are AND-ed; an empty list is always applicable within the window. */
export type Condition =
  | { type: "cart_subtotal_min"; paise: number }
  | { type: "contains_product"; productIds: string[] }
  | { type: "contains_category"; categoryIds: string[] }
  | { type: "customer_segment"; segmentId: string }
  | { type: "first_order" }
  | { type: "channel"; channels: OrderChannel[] };

export type Effect =
  | { type: "flat_off"; paise: number }
  | { type: "percent_off"; bps: number; maxDiscountPaise?: number }
  | { type: "free_shipping" }
  | { type: "buy_x_get_y"; buyQty: number; getQty: number; getVariantIds: string[] };

/** A promotions row as domain data (conditions/effects already parsed). */
export type PromotionData = {
  id: string;
  code: string;
  name: string;
  status: PromotionStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  conditions: Condition[];
  effects: Effect[];
  usageLimitTotal: number | null;
  usageLimitPerCustomer: number | null;
};

export type CartForEvaluation = {
  lines: {
    variantId: string;
    productId: string;
    categoryIds: string[];
    quantity: number;
    unitPricePaise: number;
  }[];
  subtotalPaise: number;
  shippingPaise: number;
  channel: OrderChannel;
};

/** null = anonymous preview; `first_order` then reports "may apply". */
export type CustomerForEvaluation = { id: string | null; isFirstOrder: boolean } | null;

export type AppliedDiscount = {
  promotionId: string;
  code: string;
  /** Total off ITEM lines, pre-tax; the shipping effect is the flag below. */
  discountPaise: number;
  freeShipping: boolean;
};

/** Refusal reasons are API contract — keep them stable. */
export type PromotionRefusalReason =
  | "not_started"
  | "expired"
  | "conditions_not_met"
  | "coupon_exhausted"
  | "requires_customer"
  | "unknown_condition"
  | "unsupported_condition";

/** Zod validation for stored/POSTed rules. FULL blueprint §4.4 unions. */
export const conditionSchema: z.ZodType<Condition> = z.custom<Condition>(() => {
  throw new Error("S0 stub: implemented by lot B2");
});

export const effectSchema: z.ZodType<Effect> = z.custom<Effect>(() => {
  throw new Error("S0 stub: implemented by lot B2");
});

/**
 * Pure evaluation: no DB, no env, clock passed in. An unknown condition
 * type in stored jsonb refuses with `unknown_condition` — forward-compat,
 * never a throw, never a silent pass. Window is inclusive-start,
 * exclusive-end.
 */
export function evaluatePromotion(
  _promo: PromotionData,
  _cart: CartForEvaluation,
  _customer: CustomerForEvaluation,
  _now: Date,
):
  | { applicable: true; discount: AppliedDiscount }
  | { applicable: false; reason: PromotionRefusalReason } {
  throw new Error("S0 stub: implemented by lot B2");
}

/**
 * Largest-remainder allocation of the discount across item lines,
 * pre-tax: sum(lineDiscountsPaise) === discount.discountPaise EXACTLY.
 * Returns the post-effect shipping fee (0 when freeShipping).
 */
export function applyDiscountToLines(
  _lines: readonly { lineTotalPaise: number }[],
  _discount: AppliedDiscount,
  _shippingPaise: number,
): { lineDiscountsPaise: number[]; shippingPaise: number } {
  throw new Error("S0 stub: implemented by lot B2");
}
