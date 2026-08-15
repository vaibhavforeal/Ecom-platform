import { z } from "zod";

import { ORDER_CHANNELS, PROMOTION_STATUSES } from "@platform/db/schema";
import type { OrderChannel, PromotionStatus } from "@platform/db/schema";

// Client-needed constants live in the PURE barrel (module-hygiene rule):
// the console's channel-condition editor renders this list.
export { ORDER_CHANNELS };
export type { OrderChannel };

/**
 * Promotions — PURE barrel, safe for client bundles (the console
 * promotion builder imports the Condition/Effect types). Rules are DATA
 * (blueprint §4.4): the FULL vocabulary ships now, including
 * `buy_x_get_y` and `customer_segment` — the latter evaluates to
 * {applicable:false, reason:'unsupported_condition'} until segments
 * exist (Phase 4): reserved-but-honest, never a silent pass.
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

/**
 * Money bound for rule fields: ₹100 crore in paise. Generous for any
 * Phase 2 merchant, and it keeps every downstream integer computation
 * (sums of a handful of effects) far inside Number.MAX_SAFE_INTEGER.
 */
export const MAX_RULE_PAISE = 10_000_000_000_000;

const rulePaise = (min: number) => z.number().int().min(min).max(MAX_RULE_PAISE);
const uuidList = z.array(z.string().uuid()).min(1).max(200);

/** Zod validation for stored/POSTed rules. FULL blueprint §4.4 unions. */
export const conditionSchema: z.ZodType<Condition> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cart_subtotal_min"), paise: rulePaise(0) }),
  z.object({ type: z.literal("contains_product"), productIds: uuidList }),
  z.object({ type: z.literal("contains_category"), categoryIds: uuidList }),
  // Segments arrive in Phase 4; the shape is accepted NOW so stored rules
  // never need a migration, but evaluation refuses (see below).
  z.object({ type: z.literal("customer_segment"), segmentId: z.string().min(1).max(100) }),
  z.object({ type: z.literal("first_order") }),
  z.object({ type: z.literal("channel"), channels: z.array(z.enum(ORDER_CHANNELS)).min(1) }),
]);

export const effectSchema: z.ZodType<Effect> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("flat_off"), paise: rulePaise(1) }),
  z.object({
    type: z.literal("percent_off"),
    bps: z.number().int().min(1).max(10_000),
    // 0 is legal — a cap of 0 is a zero-value discount, not an error.
    maxDiscountPaise: rulePaise(0).optional(),
  }),
  z.object({ type: z.literal("free_shipping") }),
  z.object({
    type: z.literal("buy_x_get_y"),
    buyQty: z.number().int().min(1).max(10_000),
    getQty: z.number().int().min(1).max(10_000),
    getVariantIds: uuidList,
  }),
]);

/**
 * subtotal × bps / 10000, rounded HALF_UP, in exact integer arithmetic.
 * BigInt because subtotal × bps can pass 2^53 long before the subtotal
 * itself is implausible.
 */
function bpsOf(subtotalPaise: number, bps: number): number {
  return Number((BigInt(subtotalPaise) * BigInt(bps) + 5_000n) / 10_000n);
}

/** null = pass; otherwise the refusal reason. */
function checkCondition(
  condition: Condition,
  cart: CartForEvaluation,
  customer: CustomerForEvaluation,
): PromotionRefusalReason | null {
  switch (condition.type) {
    case "cart_subtotal_min":
      return cart.subtotalPaise >= condition.paise ? null : "conditions_not_met";
    case "contains_product": {
      const wanted = new Set(condition.productIds);
      return cart.lines.some((l) => wanted.has(l.productId)) ? null : "conditions_not_met";
    }
    case "contains_category": {
      const wanted = new Set(condition.categoryIds);
      return cart.lines.some((l) => l.categoryIds.some((c) => wanted.has(c)))
        ? null
        : "conditions_not_met";
    }
    case "customer_segment":
      // Phase 4 vocabulary, reserved-but-honest: never a silent pass.
      return "unsupported_condition";
    case "first_order":
      // Anonymous PREVIEW (no customer context at all): "may apply" —
      // the coupon shows as applicable; checkout re-evaluates with the
      // real first_order_at answer.
      if (customer === null) return null;
      return customer.isFirstOrder ? null : "conditions_not_met";
    case "channel":
      return condition.channels.includes(cart.channel) ? null : "conditions_not_met";
    default:
      // Stored jsonb from a future vocabulary: refuse, never throw,
      // never silently pass (forward-compat contract).
      return "unknown_condition";
  }
}

/**
 * The buy_x_get_y discount in paise, or null when the effect cannot
 * apply: the buy threshold (whole-cart quantity) is not reached, or none
 * of the get-variants are in the cart. Free units are priced against the
 * CHEAPEST eligible units present, and capped at the eligible quantity
 * actually in the cart.
 */
function buyXGetYDiscount(
  effect: Extract<Effect, { type: "buy_x_get_y" }>,
  cart: CartForEvaluation,
): number | null {
  const eligible = cart.lines
    .filter((l) => effect.getVariantIds.includes(l.variantId))
    .sort((a, b) => a.unitPricePaise - b.unitPricePaise);
  if (eligible.length === 0) return null;

  const totalQuantity = cart.lines.reduce((sum, l) => sum + l.quantity, 0);
  const batches = Math.floor(totalQuantity / effect.buyQty);
  if (batches === 0) return null;

  let freeUnits = batches * effect.getQty;
  let discount = 0;
  for (const line of eligible) {
    if (freeUnits === 0) break;
    const take = Math.min(freeUnits, line.quantity);
    discount += take * line.unitPricePaise;
    freeUnits -= take;
  }
  return discount;
}

/**
 * Pure evaluation: no DB, no env, clock passed in. An unknown condition
 * type in stored jsonb refuses with `unknown_condition` — forward-compat,
 * never a throw, never a silent pass. Window is inclusive-start,
 * exclusive-end.
 */
export function evaluatePromotion(
  promo: PromotionData,
  cart: CartForEvaluation,
  customer: CustomerForEvaluation,
  now: Date,
):
  | { applicable: true; discount: AppliedDiscount }
  | { applicable: false; reason: PromotionRefusalReason } {
  if (promo.startsAt !== null && now.getTime() < promo.startsAt.getTime()) {
    return { applicable: false, reason: "not_started" };
  }
  if (promo.endsAt !== null && now.getTime() >= promo.endsAt.getTime()) {
    return { applicable: false, reason: "expired" };
  }

  for (const condition of promo.conditions) {
    const refusal = checkCondition(condition, cart, customer);
    if (refusal !== null) return { applicable: false, reason: refusal };
  }

  // A per-customer-limited promotion cannot be honoured for a buyer who
  // is DEFINITELY unidentifiable ({id: null} at checkout): the customer
  // slot index only guards non-null customer ids, so allowing it would
  // bypass the limit. The anonymous PREVIEW (customer === null) stays
  // lenient — checkout re-evaluates once the phone identifies the buyer.
  if (
    promo.usageLimitPerCustomer !== null &&
    customer !== null &&
    customer.id === null
  ) {
    return { applicable: false, reason: "requires_customer" };
  }

  let discountPaise = 0;
  let freeShipping = false;
  for (const effect of promo.effects) {
    switch (effect.type) {
      case "flat_off":
        discountPaise += effect.paise;
        break;
      case "percent_off": {
        let off = bpsOf(cart.subtotalPaise, effect.bps);
        if (effect.maxDiscountPaise !== undefined && off > effect.maxDiscountPaise) {
          off = effect.maxDiscountPaise;
        }
        discountPaise += off;
        break;
      }
      case "free_shipping":
        // Zero-value when shipping is already 0 — still applied.
        freeShipping = true;
        break;
      case "buy_x_get_y": {
        const off = buyXGetYDiscount(effect, cart);
        if (off === null) return { applicable: false, reason: "conditions_not_met" };
        discountPaise += off;
        break;
      }
      default:
        // Unknown effect vocabulary from the future: same honest refusal
        // as an unknown condition — never silently drop a rule.
        return { applicable: false, reason: "unknown_condition" };
    }
  }

  // flat_off greater than the subtotal clamps — never a negative total.
  discountPaise = Math.min(discountPaise, cart.subtotalPaise);

  return {
    applicable: true,
    discount: {
      promotionId: promo.id,
      code: promo.code,
      discountPaise,
      freeShipping,
    },
  };
}

/**
 * Largest-remainder allocation of the discount across item lines,
 * pre-tax: sum(lineDiscountsPaise) === discount.discountPaise EXACTLY.
 * Returns the post-effect shipping fee (0 when freeShipping).
 *
 * Floor each proportional share, then hand the leftover paise out by
 * descending fractional remainder (ties: larger line first, then input
 * order) — so 100p across three equal lines is 34/33/33 and a zero-value
 * line never receives a paise ahead of a priced one.
 */
export function applyDiscountToLines(
  lines: readonly { lineTotalPaise: number }[],
  discount: AppliedDiscount,
  shippingPaise: number,
): { lineDiscountsPaise: number[]; shippingPaise: number } {
  const shippingAfter = discount.freeShipping ? 0 : shippingPaise;
  const target = discount.discountPaise;
  const total = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);

  if (lines.length === 0 || total === 0 || target === 0) {
    return { lineDiscountsPaise: lines.map(() => 0), shippingPaise: shippingAfter };
  }

  const shares = lines.map((line, index) => {
    const numerator = BigInt(line.lineTotalPaise) * BigInt(target);
    const denominator = BigInt(total);
    return {
      index,
      floor: Number(numerator / denominator),
      // remainder < total ≤ MAX_RULE_PAISE × lines, safely a number.
      remainder: Number(numerator % denominator),
      lineTotalPaise: line.lineTotalPaise,
    };
  });

  const allocations = shares.map((s) => s.floor);
  let leftover = target - shares.reduce((sum, s) => sum + s.floor, 0);

  const byRemainder = [...shares].sort(
    (a, b) =>
      b.remainder - a.remainder ||
      b.lineTotalPaise - a.lineTotalPaise ||
      a.index - b.index,
  );
  for (let i = 0; leftover > 0; i = (i + 1) % byRemainder.length) {
    const at = byRemainder[i]!.index;
    allocations[at] = (allocations[at] ?? 0) + 1;
    leftover -= 1;
  }

  return { lineDiscountsPaise: allocations, shippingPaise: shippingAfter };
}
