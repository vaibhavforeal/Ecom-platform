import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { computeCheckoutFingerprint } from "../src/checkout/index";

/**
 * §6.5 canonicalization, plus the load-bearing extra: the pure barrel
 * ships its own SHA-256 (node:crypto would break the client bundle), so
 * every vector here is cross-checked against node:crypto over the SAME
 * canonical JSON — the two implementations can never drift silently.
 */

function nodeFingerprint(input: {
  lines: { variantId: string; quantity: number }[];
  pincode: string;
  stateCode: string;
  paymentMode: string;
  couponCode: string | null;
  buyerPhone: string;
}): string {
  const canonical = JSON.stringify({
    lines: [...input.lines]
      .sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0))
      .map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    pincode: input.pincode.trim(),
    stateCode: input.stateCode.trim().toUpperCase(),
    paymentMode: input.paymentMode,
    couponCode: input.couponCode?.trim().toUpperCase() || null,
    buyerPhone: input.buyerPhone.trim(),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

const base = {
  lines: [
    { variantId: "0192aaaa-0000-7000-8000-000000000001", quantity: 2 },
    { variantId: "0192bbbb-0000-7000-8000-000000000002", quantity: 1 },
  ],
  pincode: "110001",
  stateCode: "07",
  paymentMode: "prepaid",
  couponCode: null,
  buyerPhone: "+919876543210",
};

describe("computeCheckoutFingerprint (§6.5)", () => {
  it("matches node:crypto's SHA-256 over the canonical JSON (implementation pin)", () => {
    expect(computeCheckoutFingerprint(base)).toBe(nodeFingerprint(base));
    // Multi-block message (> 64 bytes is already true; push past 128 to
    // exercise several compression blocks) and non-ASCII UTF-8.
    const long = {
      ...base,
      buyerPhone: "+919876543210",
      couponCode: "दीपावली-MEGA-SALE-2026",
      lines: Array.from({ length: 12 }, (_, i) => ({
        variantId: `0192cccc-0000-7000-8000-${String(i).padStart(12, "0")}`,
        quantity: i + 1,
      })),
    };
    expect(computeCheckoutFingerprint(long)).toBe(nodeFingerprint(long));
  });

  it("is a 64-char lowercase hex sha256 and deterministic", () => {
    const a = computeCheckoutFingerprint(base);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computeCheckoutFingerprint(base)).toBe(a);
  });

  it("line order does not affect the hash; quantities and variants do", () => {
    const reversed = { ...base, lines: [...base.lines].reverse() };
    expect(computeCheckoutFingerprint(reversed)).toBe(computeCheckoutFingerprint(base));

    const bumped = {
      ...base,
      lines: [{ ...base.lines[0]!, quantity: 3 }, base.lines[1]!],
    };
    expect(computeCheckoutFingerprint(bumped)).not.toBe(computeCheckoutFingerprint(base));
  });

  it("couponCode null, absent-ish empty string and whitespace all canonicalize together", () => {
    const withNull = computeCheckoutFingerprint({ ...base, couponCode: null });
    const withEmpty = computeCheckoutFingerprint({ ...base, couponCode: "" });
    const withSpace = computeCheckoutFingerprint({ ...base, couponCode: "   " });
    expect(withEmpty).toBe(withNull);
    expect(withSpace).toBe(withNull);
    expect(computeCheckoutFingerprint({ ...base, couponCode: "SAVE10" })).not.toBe(withNull);
  });

  it("coupon and state are case-normalized; phone and pincode are trimmed", () => {
    expect(computeCheckoutFingerprint({ ...base, couponCode: "save10" })).toBe(
      computeCheckoutFingerprint({ ...base, couponCode: "SAVE10" }),
    );
    expect(computeCheckoutFingerprint({ ...base, stateCode: " 07 " })).toBe(
      computeCheckoutFingerprint(base),
    );
    expect(
      computeCheckoutFingerprint({ ...base, buyerPhone: " +919876543210 ", pincode: " 110001 " }),
    ).toBe(computeCheckoutFingerprint(base));
  });

  it("every non-line field participates in the hash", () => {
    expect(computeCheckoutFingerprint({ ...base, pincode: "110002" })).not.toBe(
      computeCheckoutFingerprint(base),
    );
    expect(computeCheckoutFingerprint({ ...base, stateCode: "29" })).not.toBe(
      computeCheckoutFingerprint(base),
    );
    expect(computeCheckoutFingerprint({ ...base, paymentMode: "cod" })).not.toBe(
      computeCheckoutFingerprint(base),
    );
    expect(computeCheckoutFingerprint({ ...base, buyerPhone: "+919876543211" })).not.toBe(
      computeCheckoutFingerprint(base),
    );
  });
});
