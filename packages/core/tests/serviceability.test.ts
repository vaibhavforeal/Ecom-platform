import { describe, expect, it } from "vitest";

import { AppError } from "../src/errors";
import {
  GST_STATE_NAMES,
  PINCODE_PREFIX_STATES,
  PINCODE_RE,
  computeShippingFeePaise,
  statesForPincode,
} from "../src/serviceability/index";

/**
 * Serviceability pure barrel (spec §6.4, design D3): the static
 * prefix→states map that cross-checks the buyer-typed state before the
 * CGST/SGST-vs-IGST fork, plus the §1.10 flat-fee/free-above rule.
 */

describe("PINCODE_RE", () => {
  it("accepts exactly six digits not starting with 0", () => {
    expect(PINCODE_RE.test("110001")).toBe(true);
    expect(PINCODE_RE.test("851101")).toBe(true);
  });

  it("rejects malformed shapes", () => {
    for (const bad of ["011001", "11000", "1100011", "11000a", " 110001", "110 001", ""]) {
      expect(PINCODE_RE.test(bad)).toBe(false);
    }
  });
});

describe("statesForPincode", () => {
  it("maps a single-state prefix to exactly its GST code", () => {
    expect(statesForPincode("110001")).toEqual(["07"]); // Delhi
    expect(statesForPincode("560001")).toEqual(["29"]); // Bengaluru → Karnataka
  });

  it("returns the FULL set for multi-state prefixes (safety over precision)", () => {
    // Goa's 403xxx sits inside Maharashtra's 40 prefix.
    expect(statesForPincode("403101")).toEqual(expect.arrayContaining(["27", "30"]));
    // Puducherry (605xxx) inside Tamil Nadu's 60 prefix.
    expect(statesForPincode("605001")).toEqual(expect.arrayContaining(["33", "34"]));
    // The 79 prefix covers six North-Eastern states.
    expect([...statesForPincode("790001")].sort()).toEqual([
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
    ]);
  });

  it("covers the bifurcation interleavings both ways", () => {
    // Roorkee (Uttarakhand) and Saharanpur (UP) share the 247 range.
    expect(statesForPincode("247667")).toEqual(expect.arrayContaining(["09", "05"]));
    // Ranchi (Jharkhand) sits in Bihar's historical 83 range.
    expect(statesForPincode("834001")).toEqual(expect.arrayContaining(["10", "20"]));
  });

  it("returns [] for an unknown prefix — fail-OPEN, never a refusal", () => {
    expect(statesForPincode("100001")).toEqual([]); // 10 unallocated
    expect(statesForPincode("990001")).toEqual([]); // army postal range, unmapped
  });

  it("refuses a malformed shape BEFORE any lookup", () => {
    for (const bad of ["012345", "abc", "1234567", ""]) {
      let thrown: unknown;
      try {
        statesForPincode(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("invalid_payload");
      expect((thrown as AppError).status).toBe(422);
    }
  });

  it("supports the D3 mismatch check: a typed state outside the set is detectable", () => {
    // Buyer typed Delhi ("07") with a Mumbai pincode — the checkout
    // refusal (422 pincode_state_mismatch) hangs off exactly this test.
    const allowed = statesForPincode("400001");
    expect(allowed).toContain("27");
    expect(allowed).not.toContain("07");
  });
});

describe("PINCODE_PREFIX_STATES data integrity", () => {
  it("keys are 2-digit prefixes and every value is a known, non-retired GST code", () => {
    const entries = Object.entries(PINCODE_PREFIX_STATES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [prefix, codes] of entries) {
      expect(prefix).toMatch(/^[1-9][0-9]$/);
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) {
        // Every mapped code must render in the state selector — an
        // unmappable code would make its states unselectable-yet-required.
        expect(GST_STATE_NAMES[code], `${prefix} → ${code}`).toBeDefined();
      }
      // No duplicates inside a set.
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it("retired GST codes (25 Daman & Diu, 28 old AP) appear nowhere", () => {
    for (const codes of Object.values(PINCODE_PREFIX_STATES)) {
      expect(codes).not.toContain("25");
      expect(codes).not.toContain("28");
    }
    expect(GST_STATE_NAMES["25"]).toBeUndefined();
    expect(GST_STATE_NAMES["28"]).toBeUndefined();
  });
});

describe("computeShippingFeePaise (§1.10 flat fee + free-above)", () => {
  it("charges the flat fee below the threshold", () => {
    expect(computeShippingFeePaise(49_900, { flatFeePaise: 5_000, freeAbovePaise: 50_000 })).toBe(
      5_000,
    );
  });

  it("waives the fee AT the threshold (>=, not >)", () => {
    expect(computeShippingFeePaise(50_000, { flatFeePaise: 5_000, freeAbovePaise: 50_000 })).toBe(
      0,
    );
  });

  it("null threshold means the flat fee always applies; fee 0 is free shipping", () => {
    expect(
      computeShippingFeePaise(10_000_000, { flatFeePaise: 5_000, freeAbovePaise: null }),
    ).toBe(5_000);
    expect(computeShippingFeePaise(100, { flatFeePaise: 0, freeAbovePaise: null })).toBe(0);
  });

  it("refuses non-integer or negative amounts (money is integer paise)", () => {
    for (const call of [
      () => computeShippingFeePaise(10.5, { flatFeePaise: 100, freeAbovePaise: null }),
      () => computeShippingFeePaise(-1, { flatFeePaise: 100, freeAbovePaise: null }),
      () => computeShippingFeePaise(100, { flatFeePaise: -100, freeAbovePaise: null }),
      () => computeShippingFeePaise(100, { flatFeePaise: 100, freeAbovePaise: 0.5 }),
    ]) {
      expect(call).toThrowError(AppError);
    }
  });
});
