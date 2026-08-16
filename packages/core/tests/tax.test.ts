import { describe, expect, it } from "vitest";

import { AppError } from "../src/errors";
import {
  allocateProportionally,
  computeLineTaxes,
  docTypeFor,
  financialYearOf,
  roundHalfUp,
} from "../src/tax/index";
import type { TaxContext, TaxableLine } from "../src/tax/index";

/**
 * D20 pinned vectors — exact integers, audit-grade. Do not "simplify"
 * these into computed expressions: the point is that a human can check
 * them against the GST arithmetic by hand.
 */

// Pin 1: ₹999 tax-inclusive @ 18% GST.
// 99,900 × 1,800 / 11,800 = 15,238.98… → HALF_UP → 15,239 paise.
const RS999_GROSS_PAISE = 99_900;
const RS999_TAX_PAISE = 15_239;
const RS999_BASE_PAISE = 84_661; // 99,900 − 15,239
const RS999_CGST_PAISE = 7_620; // HALF_UP(15,239 / 2)
const RS999_SGST_PAISE = 7_619; // 15,239 − 7,620 (sum-invariant, D18)

// Pin 2: three identical ₹99.94 lines @ 18% inclusive — per-line rounding
// vs sum-then-round diverge by EXACTLY 1 paisa.
//   per line: 9,994 × 1,800 / 11,800 = 1,524.508… → 1,525
//   Σ per-line = 3 × 1,525               = 4,575
//   sum-then-round: 29,982 × 1,800 / 11,800 = 4,573.52… → 4,574
const DIVERGENT_LINE_GROSS_PAISE = 9_994;
const DIVERGENT_LINE_TAX_PAISE = 1_525;
const DIVERGENT_PER_LINE_SUM_PAISE = 4_575;
const DIVERGENT_SUM_THEN_ROUND_PAISE = 4_574;

// Pin 3 lives in the financialYearOf suite:
// 2026-03-31T19:00:00Z = Apr 1 00:30 IST → '2026-27'.

const KARNATAKA = "29";
const MAHARASHTRA = "27";

function ctx(overrides: Partial<TaxContext> = {}): TaxContext {
  return {
    sellerStateCode: KARNATAKA,
    placeOfSupplyStateCode: KARNATAKA,
    registrationType: "regular",
    inclusive: true,
    ...overrides,
  };
}

function line(taxablePaise: number, taxRateBps = 1_800, lineId = "L1"): TaxableLine {
  return { lineId, taxablePaise, taxRateBps };
}

describe("roundHalfUp", () => {
  it("returns exact quotients unchanged", () => {
    expect(roundHalfUp(150, 10)).toBe(15);
    expect(roundHalfUp(0, 7)).toBe(0);
    expect(roundHalfUp(424_800, 11_800)).toBe(36);
  });

  it("rounds down below the half", () => {
    expect(roundHalfUp(141, 10)).toBe(14);
    expect(roundHalfUp(104, 10)).toBe(10);
  });

  it("rounds exactly .5 up (away from zero)", () => {
    expect(roundHalfUp(145, 10)).toBe(15);
    expect(roundHalfUp(15, 2)).toBe(8);
    expect(roundHalfUp(1, 2)).toBe(1);
  });

  it("rounds above the half up", () => {
    expect(roundHalfUp(146, 10)).toBe(15);
    expect(roundHalfUp(149, 10)).toBe(15);
  });

  it("rounds negative values away from zero at exactly .5", () => {
    expect(roundHalfUp(-15, 2)).toBe(-8);
    expect(roundHalfUp(-141, 10)).toBe(-14);
    expect(roundHalfUp(141, -10)).toBe(-14);
    expect(roundHalfUp(-141, -10)).toBe(14);
  });

  it("is exact on huge safe integers (no float drift)", () => {
    expect(roundHalfUp(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
    // 8,999,999,999,999,999 / 7 = 1,285,714,285,714,285.57… → HALF_UP
    // rounds up to 1,285,714,285,714,286.
    expect(roundHalfUp(8_999_999_999_999_999, 7)).toBe(1_285_714_285_714_286);
  });

  it("refuses non-integers and a zero denominator", () => {
    expect(() => roundHalfUp(1.5, 10)).toThrow(/safe integer/);
    expect(() => roundHalfUp(10, 2.5)).toThrow(/safe integer/);
    expect(() => roundHalfUp(10, 0)).toThrow(/non-zero/);
    expect(() => roundHalfUp(Number.NaN, 10)).toThrow(/safe integer/);
  });
});

describe("financialYearOf (IST boundary, D20 pin 3)", () => {
  it("2026-03-31T19:00:00Z is Apr 1 00:30 IST → '2026-27'", () => {
    expect(financialYearOf(new Date("2026-03-31T19:00:00Z"))).toBe("2026-27");
  });

  it("2026-03-31T18:00:00Z is still Mar 31 23:30 IST → '2025-26'", () => {
    expect(financialYearOf(new Date("2026-03-31T18:00:00Z"))).toBe("2025-26");
  });

  it("flips exactly at midnight IST (18:30:00Z)", () => {
    expect(financialYearOf(new Date("2026-03-31T18:30:00.000Z"))).toBe("2026-27");
    expect(financialYearOf(new Date("2026-03-31T18:29:59.999Z"))).toBe("2025-26");
  });

  it("mid-year instants land in the running FY", () => {
    expect(financialYearOf(new Date("2026-08-15T12:00:00Z"))).toBe("2026-27");
    expect(financialYearOf(new Date("2026-01-10T12:00:00Z"))).toBe("2025-26");
  });

  it("pads the end year to two digits across a decade rollover", () => {
    expect(financialYearOf(new Date("2029-06-01T00:00:00Z"))).toBe("2029-30");
    expect(financialYearOf(new Date("2030-06-01T00:00:00Z"))).toBe("2030-31");
  });

  it("refuses an invalid Date", () => {
    expect(() => financialYearOf(new Date("nonsense"))).toThrow(/invalid Date/);
  });
});

describe("docTypeFor", () => {
  it("regular registration issues a Tax Invoice", () => {
    expect(docTypeFor("regular")).toBe("tax_invoice");
  });

  it("unregistered issues a Bill of Supply", () => {
    expect(docTypeFor("unregistered")).toBe("bill_of_supply");
  });

  it("composition issues a Bill of Supply (cannot collect GST)", () => {
    expect(docTypeFor("composition")).toBe("bill_of_supply");
  });
});

describe("computeLineTaxes — inclusive extraction", () => {
  it("₹999 @ 18% inclusive → 15,239 paise tax (D20 pin 1)", () => {
    const result = computeLineTaxes([line(RS999_GROSS_PAISE)], ctx())[0]!;
    expect(result).toEqual({
      lineId: "L1",
      taxableExclusivePaise: RS999_BASE_PAISE,
      cgstPaise: RS999_CGST_PAISE,
      sgstPaise: RS999_SGST_PAISE,
      igstPaise: 0,
      taxPaise: RS999_TAX_PAISE,
    });
  });

  it("₹999 inter-state → IGST at the full rate, no CGST/SGST", () => {
    const result = computeLineTaxes(
      [line(RS999_GROSS_PAISE)],
      ctx({ placeOfSupplyStateCode: MAHARASHTRA }),
    )[0]!;
    expect(result).toEqual({
      lineId: "L1",
      taxableExclusivePaise: RS999_BASE_PAISE,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: RS999_TAX_PAISE,
      taxPaise: RS999_TAX_PAISE,
    });
  });

  it("per-line rounding wins over sum-then-round by exactly 1 paisa (D20 pin 2)", () => {
    const lines = [
      line(DIVERGENT_LINE_GROSS_PAISE, 1_800, "L1"),
      line(DIVERGENT_LINE_GROSS_PAISE, 1_800, "L2"),
      line(DIVERGENT_LINE_GROSS_PAISE, 1_800, "L3"),
    ];
    const results = computeLineTaxes(lines, ctx({ placeOfSupplyStateCode: MAHARASHTRA }));
    for (const r of results) expect(r.taxPaise).toBe(DIVERGENT_LINE_TAX_PAISE);
    const summed = results.reduce((sum, r) => sum + r.taxPaise, 0);
    expect(summed).toBe(DIVERGENT_PER_LINE_SUM_PAISE);
    // The forbidden computation lands 1 paisa lower — assert the
    // divergence is real and that the engine did NOT take it.
    expect(roundHalfUp(3 * DIVERGENT_LINE_GROSS_PAISE * 1_800, 11_800)).toBe(
      DIVERGENT_SUM_THEN_ROUND_PAISE,
    );
    expect(summed).toBe(DIVERGENT_SUM_THEN_ROUND_PAISE + 1);
  });

  it("the line total (quantity × unit) is the extraction base", () => {
    // 3 × ₹999 passed as ONE line of 299,700 paise:
    // 299,700 × 1,800 / 11,800 = 45,716.94… → 45,717.
    const result = computeLineTaxes([line(299_700)], ctx())[0]!;
    expect(result.taxPaise).toBe(45_717);
    expect(result.taxableExclusivePaise).toBe(299_700 - 45_717);
  });

  it("extracts exactly when no rounding is needed", () => {
    // 236 × 1,800 / 11,800 = 36 exactly → CGST 18 / SGST 18.
    const result = computeLineTaxes([line(236)], ctx())[0]!;
    expect(result.taxPaise).toBe(36);
    expect(result.cgstPaise).toBe(18);
    expect(result.sgstPaise).toBe(18);
    expect(result.taxableExclusivePaise).toBe(200);
  });

  it("is exact on max-money lines (integer math, no float drift)", () => {
    // 900,000,000,000,000 × 1,800 overflows 2^53 as a float product;
    // BigInt keeps it exact: /11,800 → 137,288,135,593,220.33… → …220.
    const result = computeLineTaxes([line(900_000_000_000_000)], ctx())[0]!;
    expect(result.taxPaise).toBe(137_288_135_593_220);
    expect(result.taxableExclusivePaise).toBe(900_000_000_000_000 - 137_288_135_593_220);
  });
});

describe("computeLineTaxes — sum-invariant odd-paise split (D18)", () => {
  it("odd tax splits cgst = HALF_UP(tax/2), sgst = tax − cgst", () => {
    // Exclusive base 100 @ 15% → tax 15 → CGST 8 / SGST 7.
    const result = computeLineTaxes([line(100, 1_500)], ctx({ inclusive: false }))[0]!;
    expect(result.taxPaise).toBe(15);
    expect(result.cgstPaise).toBe(8);
    expect(result.sgstPaise).toBe(7);
  });

  it("a 1-paisa tax splits CGST 1 / SGST 0", () => {
    // Exclusive base 10 @ 10% → tax 1.
    const result = computeLineTaxes([line(10, 1_000)], ctx({ inclusive: false }))[0]!;
    expect(result.taxPaise).toBe(1);
    expect(result.cgstPaise).toBe(1);
    expect(result.sgstPaise).toBe(0);
  });

  it("even tax splits equally", () => {
    const result = computeLineTaxes([line(236)], ctx())[0]!;
    expect(result.cgstPaise).toBe(result.sgstPaise);
  });

  it("cgst + sgst === tax for every gross from 1 to 500 paise", () => {
    const lines = Array.from({ length: 500 }, (_, i) => line(i + 1, 1_800, `L${i + 1}`));
    for (const r of computeLineTaxes(lines, ctx())) {
      expect(r.cgstPaise + r.sgstPaise).toBe(r.taxPaise);
      expect(r.igstPaise).toBe(0);
      expect(r.cgstPaise - r.sgstPaise === 0 || r.cgstPaise - r.sgstPaise === 1).toBe(true);
    }
  });
});

describe("computeLineTaxes — registration types", () => {
  it("unregistered → all zeros even with a rate on the line", () => {
    const result = computeLineTaxes(
      [line(RS999_GROSS_PAISE)],
      ctx({ registrationType: "unregistered" }),
    )[0]!;
    expect(result).toEqual({
      lineId: "L1",
      taxableExclusivePaise: RS999_GROSS_PAISE, // nothing extracted
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      taxPaise: 0,
    });
  });

  it("composition → all zeros (cannot collect GST)", () => {
    const result = computeLineTaxes(
      [line(RS999_GROSS_PAISE)],
      ctx({ registrationType: "composition" }),
    )[0]!;
    expect(result.taxPaise).toBe(0);
    expect(result.taxableExclusivePaise).toBe(RS999_GROSS_PAISE);
  });

  it("unregistered inter-state → still all zeros", () => {
    const result = computeLineTaxes(
      [line(RS999_GROSS_PAISE)],
      ctx({ registrationType: "unregistered", placeOfSupplyStateCode: MAHARASHTRA }),
    )[0]!;
    expect(result.igstPaise).toBe(0);
    expect(result.taxPaise).toBe(0);
  });
});

describe("computeLineTaxes — zero and edge lines", () => {
  it("rate 0 (exempt) → zero tax, line still present", () => {
    const results = computeLineTaxes([line(RS999_GROSS_PAISE, 0)], ctx());
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      lineId: "L1",
      taxableExclusivePaise: RS999_GROSS_PAISE,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      taxPaise: 0,
    });
  });

  it("discounted-to-zero line → taxable 0, tax 0, never negative", () => {
    const result = computeLineTaxes([line(0)], ctx())[0]!;
    expect(result.taxableExclusivePaise).toBe(0);
    expect(result.taxPaise).toBe(0);
  });

  it("empty input → empty output", () => {
    expect(computeLineTaxes([], ctx())).toEqual([]);
  });

  it("preserves line ids and order across mixed rates", () => {
    const results = computeLineTaxes(
      [line(10_000, 500, "a"), line(10_000, 1_800, "b"), line(10_000, 0, "c")],
      ctx(),
    );
    expect(results.map((r) => r.lineId)).toEqual(["a", "b", "c"]);
    expect(results[0]!.taxPaise).not.toBe(results[1]!.taxPaise);
    expect(results[2]!.taxPaise).toBe(0);
  });

  it("normalizes state codes (case/whitespace) before the intra/inter compare", () => {
    const padded = computeLineTaxes(
      [line(236)],
      ctx({ sellerStateCode: " 29 ", placeOfSupplyStateCode: "29" }),
    )[0]!;
    expect(padded.cgstPaise).toBe(18); // intra despite whitespace
    const cased = computeLineTaxes(
      [line(236)],
      ctx({ sellerStateCode: "ka", placeOfSupplyStateCode: "KA" }),
    )[0]!;
    expect(cased.cgstPaise).toBe(18); // intra despite case
  });

  it("genuinely different states stay inter-state", () => {
    const result = computeLineTaxes(
      [line(236)],
      ctx({ placeOfSupplyStateCode: MAHARASHTRA }),
    )[0]!;
    expect(result.igstPaise).toBe(36);
    expect(result.cgstPaise).toBe(0);
    expect(result.sgstPaise).toBe(0);
  });
});

describe("computeLineTaxes — exclusive mode", () => {
  it("adds tax on top of the base: 10,000 @ 18% → 1,800", () => {
    const result = computeLineTaxes([line(10_000)], ctx({ inclusive: false }))[0]!;
    expect(result.taxPaise).toBe(1_800);
    expect(result.taxableExclusivePaise).toBe(10_000); // base unchanged
  });

  it("rounds HALF_UP: 33 @ 18% → 5.94 → 6; 25 @ 18% → 4.5 → 5", () => {
    const results = computeLineTaxes(
      [line(33, 1_800, "a"), line(25, 1_800, "b")],
      ctx({ inclusive: false, placeOfSupplyStateCode: MAHARASHTRA }),
    );
    expect(results[0]!.taxPaise).toBe(6);
    expect(results[1]!.taxPaise).toBe(5);
  });

  it("splits the exclusive tax sum-invariantly intra-state", () => {
    // 25 @ 18% → tax 5 → CGST 3 / SGST 2.
    const result = computeLineTaxes([line(25)], ctx({ inclusive: false }))[0]!;
    expect(result.cgstPaise).toBe(3);
    expect(result.sgstPaise).toBe(2);
  });
});

describe("computeLineTaxes — input validation", () => {
  it("refuses a negative taxable amount", () => {
    expect(() => computeLineTaxes([line(-1)], ctx())).toThrowError(AppError);
    try {
      computeLineTaxes([line(-1)], ctx());
    } catch (err) {
      expect((err as AppError).code).toBe("invalid_payload");
      expect((err as AppError).status).toBe(422);
    }
  });

  it("refuses non-integer paise (floats never enter money paths)", () => {
    expect(() => computeLineTaxes([line(99_900.5)], ctx())).toThrowError(AppError);
  });

  it("refuses a negative or fractional rate", () => {
    expect(() => computeLineTaxes([line(100, -1)], ctx())).toThrowError(AppError);
    expect(() => computeLineTaxes([line(100, 18.5)], ctx())).toThrowError(AppError);
  });
});

describe("allocateProportionally (largest remainder)", () => {
  it("100 paise over 3 equal lines → [34, 33, 33], sums exactly", () => {
    const shares = allocateProportionally(100, [1, 1, 1]);
    expect(shares).toEqual([34, 33, 33]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("hands leftover paise to the largest remainders", () => {
    // 101 over weights [3,3,1] (W=7): floors [43,43,14], remainders
    // [2,2,3] → the single leftover paisa goes to the THIRD line.
    expect(allocateProportionally(101, [3, 3, 1])).toEqual([43, 43, 15]);
  });

  it("a zero-weight line gets 0", () => {
    expect(allocateProportionally(100, [1, 0, 1])).toEqual([50, 0, 50]);
    expect(allocateProportionally(101, [1, 0, 1])).toEqual([51, 0, 50]);
  });

  it("total 0 allocates zeros", () => {
    expect(allocateProportionally(0, [5, 3])).toEqual([0, 0]);
    expect(allocateProportionally(0, [0, 0])).toEqual([0, 0]);
    expect(allocateProportionally(0, [])).toEqual([]);
  });

  it("refuses a non-zero total over all-zero weights", () => {
    expect(() => allocateProportionally(100, [0, 0])).toThrowError(AppError);
    expect(() => allocateProportionally(100, [])).toThrowError(AppError);
  });

  it("a single line takes the whole amount", () => {
    expect(allocateProportionally(999, [123])).toEqual([999]);
  });

  it("sums exactly on large awkward inputs (integer math)", () => {
    const total = 999_999_999_999;
    const shares = allocateProportionally(total, [7, 11, 13]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
    expect(shares).toHaveLength(3);
  });

  it("ties break toward earlier lines", () => {
    // 1 paisa over two equal weights: both remainders equal → first line.
    expect(allocateProportionally(1, [1, 1])).toEqual([1, 0]);
  });

  it("refuses negative or fractional inputs", () => {
    expect(() => allocateProportionally(-1, [1])).toThrowError(AppError);
    expect(() => allocateProportionally(10, [1, -1])).toThrowError(AppError);
    expect(() => allocateProportionally(10.5, [1])).toThrowError(AppError);
    expect(() => allocateProportionally(10, [1.5])).toThrowError(AppError);
  });
});
