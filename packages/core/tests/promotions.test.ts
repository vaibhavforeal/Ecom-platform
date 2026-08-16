import { describe, expect, it } from "vitest";

import {
  applyDiscountToLines,
  conditionSchema,
  effectSchema,
  evaluatePromotion,
} from "../src/promotions/index";
import type {
  AppliedDiscount,
  CartForEvaluation,
  Condition,
  CustomerForEvaluation,
  Effect,
  PromotionData,
} from "../src/promotions/index";

/**
 * The promotion engine, exhaustively: rule vocabulary schemas, every
 * evaluatePromotion branch (each condition pass/fail, every refusal
 * reason, buy_x_get_y multiples, window boundaries) and the allocation
 * invariant. Discount bugs cost money — 100% branch is the bar (§6.3).
 */

const UUID_A = "0198c0de-0000-7000-8000-00000000000a";
const UUID_B = "0198c0de-0000-7000-8000-00000000000b";
const UUID_C = "0198c0de-0000-7000-8000-00000000000c";

function promo(overrides: Partial<PromotionData> = {}): PromotionData {
  return {
    id: "0198c0de-1111-7000-8000-000000000001",
    code: "TEST10",
    name: "Test promotion",
    status: "active",
    startsAt: null,
    endsAt: null,
    conditions: [],
    effects: [{ type: "flat_off", paise: 1_000 }],
    usageLimitTotal: null,
    usageLimitPerCustomer: null,
    ...overrides,
  };
}

function cart(overrides: Partial<CartForEvaluation> = {}): CartForEvaluation {
  return {
    lines: [
      {
        variantId: UUID_A,
        productId: UUID_B,
        categoryIds: [UUID_C],
        quantity: 2,
        unitPricePaise: 50_000,
      },
    ],
    subtotalPaise: 100_000,
    shippingPaise: 5_000,
    channel: "web",
    ...overrides,
  };
}

const identified: CustomerForEvaluation = { id: UUID_A, isFirstOrder: true };
const NOW = new Date("2026-08-16T10:00:00Z");

function refusalOf(result: ReturnType<typeof evaluatePromotion>): string {
  if (result.applicable) throw new Error("expected a refusal, got applicable");
  return result.reason;
}

function discountOf(result: ReturnType<typeof evaluatePromotion>): AppliedDiscount {
  if (!result.applicable) throw new Error(`expected applicable, got ${result.reason}`);
  return result.discount;
}

describe("conditionSchema", () => {
  it("accepts every condition type in the §4.4 vocabulary", () => {
    const conditions: Condition[] = [
      { type: "cart_subtotal_min", paise: 99_900 },
      { type: "contains_product", productIds: [UUID_A] },
      { type: "contains_category", categoryIds: [UUID_B, UUID_C] },
      { type: "customer_segment", segmentId: "vip" },
      { type: "first_order" },
      { type: "channel", channels: ["web", "pos"] },
    ];
    for (const condition of conditions) {
      expect(conditionSchema.safeParse(condition).success, condition.type).toBe(true);
    }
  });

  it("rejects an unknown condition type", () => {
    expect(conditionSchema.safeParse({ type: "moon_phase", phase: "full" }).success).toBe(false);
  });

  it("rejects a negative or fractional subtotal minimum", () => {
    expect(conditionSchema.safeParse({ type: "cart_subtotal_min", paise: -1 }).success).toBe(false);
    expect(conditionSchema.safeParse({ type: "cart_subtotal_min", paise: 10.5 }).success).toBe(false);
  });

  it("rejects empty id lists and non-uuid ids", () => {
    expect(conditionSchema.safeParse({ type: "contains_product", productIds: [] }).success).toBe(false);
    expect(
      conditionSchema.safeParse({ type: "contains_category", categoryIds: ["shoes"] }).success,
    ).toBe(false);
  });

  it("rejects an empty channel list and an unknown channel", () => {
    expect(conditionSchema.safeParse({ type: "channel", channels: [] }).success).toBe(false);
    expect(conditionSchema.safeParse({ type: "channel", channels: ["carrier-pigeon"] }).success).toBe(
      false,
    );
  });

  it("strips unknown keys rather than storing them", () => {
    const parsed = conditionSchema.safeParse({ type: "first_order", extra: "smuggled" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && "extra" in parsed.data).toBe(false);
  });
});

describe("effectSchema", () => {
  it("accepts every effect type in the §4.4 vocabulary", () => {
    const effects: Effect[] = [
      { type: "flat_off", paise: 10_000 },
      { type: "percent_off", bps: 1_000 },
      { type: "percent_off", bps: 10_000, maxDiscountPaise: 50_000 },
      { type: "free_shipping" },
      { type: "buy_x_get_y", buyQty: 2, getQty: 1, getVariantIds: [UUID_A] },
    ];
    for (const effect of effects) {
      expect(effectSchema.safeParse(effect).success, effect.type).toBe(true);
    }
  });

  it("accepts maxDiscountPaise 0 — a zero cap is a rule, not an error", () => {
    expect(
      effectSchema.safeParse({ type: "percent_off", bps: 500, maxDiscountPaise: 0 }).success,
    ).toBe(true);
  });

  it("rejects bps outside 1..10000", () => {
    expect(effectSchema.safeParse({ type: "percent_off", bps: 0 }).success).toBe(false);
    expect(effectSchema.safeParse({ type: "percent_off", bps: 10_001 }).success).toBe(false);
  });

  it("rejects a zero or negative flat_off", () => {
    expect(effectSchema.safeParse({ type: "flat_off", paise: 0 }).success).toBe(false);
    expect(effectSchema.safeParse({ type: "flat_off", paise: -100 }).success).toBe(false);
  });

  it("rejects buy_x_get_y with zero quantities or no get-variants", () => {
    expect(
      effectSchema.safeParse({ type: "buy_x_get_y", buyQty: 0, getQty: 1, getVariantIds: [UUID_A] })
        .success,
    ).toBe(false);
    expect(
      effectSchema.safeParse({ type: "buy_x_get_y", buyQty: 2, getQty: 0, getVariantIds: [UUID_A] })
        .success,
    ).toBe(false);
    expect(
      effectSchema.safeParse({ type: "buy_x_get_y", buyQty: 2, getQty: 1, getVariantIds: [] })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown effect type", () => {
    expect(effectSchema.safeParse({ type: "store_credit", paise: 100 }).success).toBe(false);
  });
});

describe("evaluatePromotion — window", () => {
  it("refuses not_started before startsAt", () => {
    const result = evaluatePromotion(
      promo({ startsAt: new Date("2026-08-17T00:00:00Z") }),
      cart(),
      identified,
      NOW,
    );
    expect(refusalOf(result)).toBe("not_started");
  });

  it("applies AT startsAt exactly (inclusive start)", () => {
    const result = evaluatePromotion(promo({ startsAt: NOW }), cart(), identified, NOW);
    expect(result.applicable).toBe(true);
  });

  it("refuses expired after endsAt", () => {
    const result = evaluatePromotion(
      promo({ endsAt: new Date("2026-08-15T00:00:00Z") }),
      cart(),
      identified,
      NOW,
    );
    expect(refusalOf(result)).toBe("expired");
  });

  it("refuses AT endsAt exactly (exclusive end)", () => {
    const result = evaluatePromotion(promo({ endsAt: NOW }), cart(), identified, NOW);
    expect(refusalOf(result)).toBe("expired");
  });

  it("applies inside a bounded window and with both bounds null", () => {
    const bounded = evaluatePromotion(
      promo({ startsAt: new Date("2026-08-15T00:00:00Z"), endsAt: new Date("2026-08-17T00:00:00Z") }),
      cart(),
      identified,
      NOW,
    );
    expect(bounded.applicable).toBe(true);
    expect(evaluatePromotion(promo(), cart(), identified, NOW).applicable).toBe(true);
  });
});

describe("evaluatePromotion — conditions", () => {
  it("an empty condition list is always applicable within the window", () => {
    expect(evaluatePromotion(promo({ conditions: [] }), cart(), null, NOW).applicable).toBe(true);
  });

  it("cart_subtotal_min passes at and above the threshold, refuses below", () => {
    const rule = promo({ conditions: [{ type: "cart_subtotal_min", paise: 100_000 }] });
    expect(evaluatePromotion(rule, cart({ subtotalPaise: 100_000 }), null, NOW).applicable).toBe(true);
    expect(evaluatePromotion(rule, cart({ subtotalPaise: 100_001 }), null, NOW).applicable).toBe(true);
    expect(
      refusalOf(evaluatePromotion(rule, cart({ subtotalPaise: 99_999 }), null, NOW)),
    ).toBe("conditions_not_met");
  });

  it("contains_product passes when any line's product matches, refuses otherwise", () => {
    const rule = promo({ conditions: [{ type: "contains_product", productIds: [UUID_B] }] });
    expect(evaluatePromotion(rule, cart(), null, NOW).applicable).toBe(true);
    const other = promo({ conditions: [{ type: "contains_product", productIds: [UUID_C] }] });
    expect(refusalOf(evaluatePromotion(other, cart(), null, NOW))).toBe("conditions_not_met");
  });

  it("contains_category intersects line categories, refuses on no overlap", () => {
    const rule = promo({ conditions: [{ type: "contains_category", categoryIds: [UUID_C] }] });
    expect(evaluatePromotion(rule, cart(), null, NOW).applicable).toBe(true);
    const other = promo({ conditions: [{ type: "contains_category", categoryIds: [UUID_A] }] });
    expect(refusalOf(evaluatePromotion(other, cart(), null, NOW))).toBe("conditions_not_met");
  });

  it("channel passes on membership, refuses on mismatch", () => {
    const rule = promo({ conditions: [{ type: "channel", channels: ["web", "pos"] }] });
    expect(evaluatePromotion(rule, cart({ channel: "pos" }), null, NOW).applicable).toBe(true);
    expect(
      refusalOf(evaluatePromotion(rule, cart({ channel: "whatsapp" }), null, NOW)),
    ).toBe("conditions_not_met");
  });

  it("first_order: anonymous preview (null customer) may apply", () => {
    const rule = promo({ conditions: [{ type: "first_order" }] });
    expect(evaluatePromotion(rule, cart(), null, NOW).applicable).toBe(true);
  });

  it("first_order: a first-time customer passes, a returning one refuses", () => {
    const rule = promo({ conditions: [{ type: "first_order" }] });
    expect(
      evaluatePromotion(rule, cart(), { id: UUID_A, isFirstOrder: true }, NOW).applicable,
    ).toBe(true);
    expect(
      refusalOf(evaluatePromotion(rule, cart(), { id: UUID_A, isFirstOrder: false }, NOW)),
    ).toBe("conditions_not_met");
  });

  it("customer_segment refuses unsupported_condition until Phase 4 — never a silent pass", () => {
    const rule = promo({ conditions: [{ type: "customer_segment", segmentId: "vip" }] });
    expect(refusalOf(evaluatePromotion(rule, cart(), identified, NOW))).toBe("unsupported_condition");
  });

  it("an unknown condition type in stored jsonb refuses unknown_condition without throwing", () => {
    const rule = promo({
      conditions: [{ type: "loyalty_tier", tier: "gold" } as unknown as Condition],
    });
    expect(refusalOf(evaluatePromotion(rule, cart(), identified, NOW))).toBe("unknown_condition");
  });

  it("conditions are AND-ed: the first failure wins, all must pass", () => {
    const rule = promo({
      conditions: [
        { type: "cart_subtotal_min", paise: 1 },
        { type: "channel", channels: ["pos"] },
        { type: "customer_segment", segmentId: "vip" },
      ],
    });
    // Second condition fails before the third is reached.
    expect(refusalOf(evaluatePromotion(rule, cart({ channel: "web" }), null, NOW))).toBe(
      "conditions_not_met",
    );
    const allPass = promo({
      conditions: [
        { type: "cart_subtotal_min", paise: 1 },
        { type: "channel", channels: ["web"] },
        { type: "first_order" },
      ],
    });
    expect(evaluatePromotion(allPass, cart(), null, NOW).applicable).toBe(true);
  });
});

describe("evaluatePromotion — requires_customer", () => {
  const limited = () => promo({ usageLimitPerCustomer: 1 });

  it("refuses a per-customer-limited coupon for a definitely-unidentifiable buyer", () => {
    const result = evaluatePromotion(limited(), cart(), { id: null, isFirstOrder: true }, NOW);
    expect(refusalOf(result)).toBe("requires_customer");
  });

  it("stays lenient at anonymous preview and for an identified customer", () => {
    expect(evaluatePromotion(limited(), cart(), null, NOW).applicable).toBe(true);
    expect(evaluatePromotion(limited(), cart(), identified, NOW).applicable).toBe(true);
  });

  it("does not fire without a per-customer limit", () => {
    const result = evaluatePromotion(
      promo({ usageLimitPerCustomer: null }),
      cart(),
      { id: null, isFirstOrder: true },
      NOW,
    );
    expect(result.applicable).toBe(true);
  });
});

describe("evaluatePromotion — effects", () => {
  it("flat_off discounts the flat amount and carries code + promotion id", () => {
    const result = discountOf(
      evaluatePromotion(promo({ effects: [{ type: "flat_off", paise: 10_000 }] }), cart(), null, NOW),
    );
    expect(result.discountPaise).toBe(10_000);
    expect(result.freeShipping).toBe(false);
    expect(result.code).toBe("TEST10");
    expect(result.promotionId).toBe(promo().id);
  });

  it("flat_off larger than the subtotal clamps — never a negative total", () => {
    const result = discountOf(
      evaluatePromotion(
        promo({ effects: [{ type: "flat_off", paise: 999_999 }] }),
        cart({ subtotalPaise: 100_000 }),
        null,
        NOW,
      ),
    );
    expect(result.discountPaise).toBe(100_000);
  });

  it("a zero-subtotal cart clamps a flat_off to zero and stays applicable", () => {
    const result = discountOf(
      evaluatePromotion(
        promo({ effects: [{ type: "flat_off", paise: 1_000 }] }),
        cart({ subtotalPaise: 0, lines: [] }),
        null,
        NOW,
      ),
    );
    expect(result.discountPaise).toBe(0);
  });

  it("percent_off computes bps of the subtotal", () => {
    const result = discountOf(
      evaluatePromotion(
        promo({ effects: [{ type: "percent_off", bps: 1_000 }] }),
        cart({ subtotalPaise: 99_900 }),
        null,
        NOW,
      ),
    );
    expect(result.discountPaise).toBe(9_990); // 10% of ₹999
  });

  it("percent_off rounds HALF_UP to the paise", () => {
    // 15 paise × 250 bps = 0.375 paise → 0? No: 15 × 250 / 10000 = 0.375 → 0.
    // Use 25 bps of 999: 999 × 25 / 10000 = 2.4975 → 2; 999 × 50 / 10000 = 4.995 → 5.
    const at = (subtotal: number, bps: number) =>
      discountOf(
        evaluatePromotion(
          promo({ effects: [{ type: "percent_off", bps }] }),
          cart({ subtotalPaise: subtotal }),
          null,
          NOW,
        ),
      ).discountPaise;
    expect(at(999, 25)).toBe(2); // 2.4975 rounds down
    expect(at(999, 50)).toBe(5); // 4.995 rounds up
    expect(at(1_000, 25)).toBe(3); // 2.5 exactly → HALF_UP → 3
  });

  it("percent_off bps 10000 discounts the full subtotal", () => {
    const result = discountOf(
      evaluatePromotion(
        promo({ effects: [{ type: "percent_off", bps: 10_000 }] }),
        cart({ subtotalPaise: 123_456 }),
        null,
        NOW,
      ),
    );
    expect(result.discountPaise).toBe(123_456);
  });

  it("percent_off caps at maxDiscountPaise when hit, not when clear, and honours cap 0", () => {
    const at = (max: number) =>
      discountOf(
        evaluatePromotion(
          promo({ effects: [{ type: "percent_off", bps: 1_000, maxDiscountPaise: max }] }),
          cart({ subtotalPaise: 100_000 }),
          null,
          NOW,
        ),
      ).discountPaise;
    expect(at(5_000)).toBe(5_000); // 10% = 10 000, capped
    expect(at(50_000)).toBe(10_000); // cap not reached
    expect(at(0)).toBe(0); // zero-value, still applied
  });

  it("free_shipping sets the flag with zero item discount — even when shipping is already 0", () => {
    const result = discountOf(
      evaluatePromotion(
        promo({ effects: [{ type: "free_shipping" }] }),
        cart({ shippingPaise: 0 }),
        null,
        NOW,
      ),
    );
    expect(result.freeShipping).toBe(true);
    expect(result.discountPaise).toBe(0);
  });

  it("multiple effects combine: amounts sum, free_shipping flags", () => {
    const result = discountOf(
      evaluatePromotion(
        promo({
          effects: [
            { type: "flat_off", paise: 5_000 },
            { type: "percent_off", bps: 500 },
            { type: "free_shipping" },
          ],
        }),
        cart({ subtotalPaise: 100_000 }),
        null,
        NOW,
      ),
    );
    expect(result.discountPaise).toBe(10_000); // 5 000 + 5%
    expect(result.freeShipping).toBe(true);
  });

  it("an unknown effect type in stored jsonb refuses — never silently dropped", () => {
    const rule = promo({ effects: [{ type: "store_credit", paise: 1 } as unknown as Effect] });
    expect(refusalOf(evaluatePromotion(rule, cart(), null, NOW))).toBe("unknown_condition");
  });
});

describe("evaluatePromotion — buy_x_get_y", () => {
  const bxgy = (buyQty: number, getQty: number, getVariantIds: string[]) =>
    promo({ effects: [{ type: "buy_x_get_y", buyQty, getQty, getVariantIds }] });

  const twoLineCart = () =>
    cart({
      lines: [
        { variantId: UUID_A, productId: UUID_B, categoryIds: [], quantity: 2, unitPricePaise: 30_000 },
        { variantId: UUID_B, productId: UUID_B, categoryIds: [], quantity: 2, unitPricePaise: 10_000 },
      ],
      subtotalPaise: 80_000,
    });

  it("refuses below the buy threshold (qty x−1)", () => {
    const result = evaluatePromotion(
      bxgy(3, 1, [UUID_A]),
      cart({ lines: [{ variantId: UUID_A, productId: UUID_B, categoryIds: [], quantity: 2, unitPricePaise: 10_000 }], subtotalPaise: 20_000 }),
      null,
      NOW,
    );
    expect(refusalOf(result)).toBe("conditions_not_met");
  });

  it("applies one batch at exactly qty x", () => {
    const result = discountOf(
      evaluatePromotion(
        bxgy(2, 1, [UUID_A]),
        cart({ lines: [{ variantId: UUID_A, productId: UUID_B, categoryIds: [], quantity: 2, unitPricePaise: 10_000 }], subtotalPaise: 20_000 }),
        null,
        NOW,
      ),
    );
    expect(result.discountPaise).toBe(10_000); // one free unit
  });

  it("applies two batches at 2x (multiples)", () => {
    const result = discountOf(
      evaluatePromotion(bxgy(2, 1, [UUID_B]), twoLineCart(), null, NOW),
    );
    // 4 units in cart / buy 2 = 2 batches → 2 free units of the ₹100 variant.
    expect(result.discountPaise).toBe(20_000);
  });

  it("prices free units against the CHEAPEST eligible units present", () => {
    const result = discountOf(
      evaluatePromotion(bxgy(4, 1, [UUID_A, UUID_B]), twoLineCart(), null, NOW),
    );
    expect(result.discountPaise).toBe(10_000); // the ₹100 unit, not the ₹300 one
  });

  it("caps free units at the eligible quantity actually in the cart", () => {
    const result = discountOf(
      evaluatePromotion(bxgy(1, 5, [UUID_B]), twoLineCart(), null, NOW),
    );
    // 4 batches × 5 = 20 nominal free units, only 2 eligible units exist.
    expect(result.discountPaise).toBe(20_000);
  });

  it("refuses when no get-variant is in the cart", () => {
    const result = evaluatePromotion(bxgy(1, 1, [UUID_C]), twoLineCart(), null, NOW);
    expect(refusalOf(result)).toBe("conditions_not_met");
  });
});

describe("applyDiscountToLines", () => {
  const flat = (paise: number, freeShipping = false): AppliedDiscount => ({
    promotionId: promo().id,
    code: "TEST10",
    discountPaise: paise,
    freeShipping,
  });

  it("splits 100p across three equal lines as 34/33/33 — sums exactly", () => {
    const { lineDiscountsPaise } = applyDiscountToLines(
      [{ lineTotalPaise: 100 }, { lineTotalPaise: 100 }, { lineTotalPaise: 100 }],
      flat(100),
      0,
    );
    expect(lineDiscountsPaise).toEqual([34, 33, 33]);
  });

  it("allocates proportionally to line totals", () => {
    const { lineDiscountsPaise } = applyDiscountToLines(
      [{ lineTotalPaise: 75_000 }, { lineTotalPaise: 25_000 }],
      flat(10_000),
      0,
    );
    expect(lineDiscountsPaise).toEqual([7_500, 2_500]);
  });

  it("hands the leftover paise to the largest remainder, largest line on ties", () => {
    // 101 across 200/100: exact shares 67.33/33.67 — the SECOND line has
    // the larger remainder and takes the leftover paise.
    const { lineDiscountsPaise } = applyDiscountToLines(
      [{ lineTotalPaise: 200 }, { lineTotalPaise: 100 }],
      flat(101),
      0,
    );
    expect(lineDiscountsPaise).toEqual([67, 34]);
    expect(lineDiscountsPaise.reduce((a, b) => a + b, 0)).toBe(101);
  });

  it("gives a zero-value line nothing", () => {
    const { lineDiscountsPaise } = applyDiscountToLines(
      [{ lineTotalPaise: 0 }, { lineTotalPaise: 100 }],
      flat(99),
      0,
    );
    expect(lineDiscountsPaise).toEqual([0, 99]);
  });

  it("zeroes shipping when the discount grants free shipping", () => {
    const result = applyDiscountToLines([{ lineTotalPaise: 100 }], flat(0, true), 5_000);
    expect(result.shippingPaise).toBe(0);
    expect(result.lineDiscountsPaise).toEqual([0]);
  });

  it("passes shipping through untouched otherwise", () => {
    const result = applyDiscountToLines([{ lineTotalPaise: 100 }], flat(50), 5_000);
    expect(result.shippingPaise).toBe(5_000);
    expect(result.lineDiscountsPaise).toEqual([50]);
  });

  it("returns all zeros for a zero discount and an empty allocation for no lines", () => {
    expect(
      applyDiscountToLines([{ lineTotalPaise: 10 }, { lineTotalPaise: 20 }], flat(0), 700)
        .lineDiscountsPaise,
    ).toEqual([0, 0]);
    expect(applyDiscountToLines([], flat(0), 700).lineDiscountsPaise).toEqual([]);
  });

  it("holds the exact-sum invariant across a sweep of awkward splits", () => {
    const lines = [
      { lineTotalPaise: 33_333 },
      { lineTotalPaise: 999 },
      { lineTotalPaise: 1 },
      { lineTotalPaise: 70_007 },
      { lineTotalPaise: 0 },
    ];
    const total = lines.reduce((s, l) => s + l.lineTotalPaise, 0);
    for (const target of [1, 7, 999, 10_000, 33_334, total - 1, total]) {
      const { lineDiscountsPaise } = applyDiscountToLines(lines, flat(target), 0);
      expect(lineDiscountsPaise.reduce((a, b) => a + b, 0), `target ${target}`).toBe(target);
      lineDiscountsPaise.forEach((d, i) => {
        expect(d, `line ${i} at target ${target}`).toBeGreaterThanOrEqual(0);
        expect(d, `line ${i} at target ${target}`).toBeLessThanOrEqual(lines[i]!.lineTotalPaise);
      });
    }
  });
});
