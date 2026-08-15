import { describe, expect, it } from "vitest";

import { blankPromotion, toPromotionPayload } from "../src/app/promotions/form-model";
import type { Issue, PromotionFormState } from "../src/app/promotions/form-model";

/**
 * Rupee inputs must go through string decimal math (the canonical
 * parseAmountToPaise), never `Number(value) * 100`. The regressions this
 * pins: ">2 decimals silently rounded to a discount the merchant did not
 * type" (99.999 → ₹100.00) and scientific notation accepted as money
 * ("1e5" → ₹1,00,000).
 */

function flatOffState(rupees: string): PromotionFormState {
  return {
    ...blankPromotion(),
    code: "SAVE10",
    name: "Save ten",
    effects: [{ type: "flat_off", rupees }],
  };
}

function issuesOf(result: ReturnType<typeof toPromotionPayload>): Issue[] {
  return result.issues;
}

describe("promotion form rupee parsing (string decimal math, never floats)", () => {
  it("parses plain and 2-decimal amounts to exact paise", () => {
    const whole = toPromotionPayload(flatOffState("100"));
    expect(whole.payload).not.toBeNull();
    expect((whole.payload!.effects as { paise: number }[])[0]!.paise).toBe(10_000);

    const cents = toPromotionPayload(flatOffState("1299.99"));
    expect((cents.payload!.effects as { paise: number }[])[0]!.paise).toBe(129_999);

    const oneDecimal = toPromotionPayload(flatOffState("99.5"));
    expect((oneDecimal.payload!.effects as { paise: number }[])[0]!.paise).toBe(9_950);
  });

  it("REJECTS more than 2 decimal places instead of silently rounding", () => {
    // Math.round(Number("99.999") * 100) would store 10000 paise (₹100.00).
    const result = toPromotionPayload(flatOffState("99.999"));
    expect(result.payload).toBeNull();
    expect(issuesOf(result)).toContainEqual(
      expect.objectContaining({ path: "effects.0" }),
    );

    const pasted = toPromotionPayload(flatOffState("1299.995"));
    expect(pasted.payload).toBeNull();
  });

  it("rejects scientific notation and other non-plain numbers", () => {
    // Number("1e5") * 100 would store ₹1,00,000.
    expect(toPromotionPayload(flatOffState("1e5")).payload).toBeNull();
    expect(toPromotionPayload(flatOffState("0x10")).payload).toBeNull();
    expect(toPromotionPayload(flatOffState("Infinity")).payload).toBeNull();
  });

  it("keeps the empty-field and too-small refusals", () => {
    const empty = toPromotionPayload(flatOffState(""));
    expect(empty.payload).toBeNull();
    expect(issuesOf(empty)).toContainEqual({
      path: "effects.0",
      message: "Enter an amount in rupees.",
    });

    // flat_off has a 1-paise floor; negatives fall under it too.
    expect(toPromotionPayload(flatOffState("0")).payload).toBeNull();
    expect(toPromotionPayload(flatOffState("-5")).payload).toBeNull();
  });

  it("applies the same parser to condition amounts (cart_subtotal_min)", () => {
    const state: PromotionFormState = {
      ...flatOffState("10"),
      conditions: [{ type: "cart_subtotal_min", rupees: "499.50" }],
    };
    const ok = toPromotionPayload(state);
    expect((ok.payload!.conditions as { paise: number }[])[0]!.paise).toBe(49_950);

    const bad = toPromotionPayload({
      ...state,
      conditions: [{ type: "cart_subtotal_min", rupees: "499.999" }],
    });
    expect(bad.payload).toBeNull();
    expect(issuesOf(bad)).toContainEqual(
      expect.objectContaining({ path: "conditions.0" }),
    );
  });
});
