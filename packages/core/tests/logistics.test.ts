import { describe, expect, it } from "vitest";

import {
  assessWeightDiscrepancy,
  computeBillableWeight,
  eventSignature,
  isStatusRegression,
  laneSuccessScore,
  selectCarrier,
  translateStatus,
  volumetricWeightGrams,
} from "../src/logistics/index";
import type { ServiceabilityQuote, StatusMap } from "../src/logistics/index";

const MAP: StatusMap = {
  out_for_delivery: { status: "out_for_delivery" },
  delivered: { status: "delivered" },
  undelivered_customer_not_available: {
    status: "delivery_failed",
    ndr: "customer_unavailable",
  },
};

// ───────────────────────────────────────────────────────────────
// Status translation
// ───────────────────────────────────────────────────────────────
describe("translateStatus", () => {
  it("prefers the carrier's explicit map", () => {
    const r = translateStatus("undelivered_customer_not_available", MAP);
    expect(r.status).toBe("delivery_failed");
    expect(r.ndr).toBe("customer_unavailable");
    expect(r.matched).toBe("map");
  });

  it("normalises spacing, case and punctuation before lookup", () => {
    // Carriers send "Out For Delivery", "OUT-FOR-DELIVERY", "out/for/delivery".
    for (const raw of ["Out For Delivery", "OUT-FOR-DELIVERY", "out/for/delivery"]) {
      expect(translateStatus(raw, MAP).status).toBe("out_for_delivery");
    }
  });

  it("does not mistake RTO delivery for a successful delivery", () => {
    // The costliest possible mis-mapping: an RTO counted as revenue,
    // stock never restocked, and the customer told their parcel arrived.
    expect(translateStatus("RTO Delivered", {}).status).toBe("rto_delivered");
    expect(translateStatus("Returned to Origin", {}).status).toBe("rto_initiated");
    expect(translateStatus("rto_in_transit", {}).status).not.toBe("delivered");
  });

  it("distinguishes a failed attempt from a delivery", () => {
    expect(translateStatus("Delivery Attempted - Unsuccessful", {}).status).toBe(
      "delivery_failed",
    );
    expect(translateStatus("Undelivered", {}).status).toBe("delivery_failed");
    expect(translateStatus("Delivered", {}).status).toBe("delivered");
  });

  it("falls back on keywords for unmapped statuses, and says so", () => {
    const r = translateStatus("Bagged at origin hub", {});
    expect(r.status).toBe("in_transit");
    expect(r.matched).toBe("keyword");
  });

  it("holds rather than inventing progress when nothing matches", () => {
    const r = translateStatus("Zorblatt event 47", {});
    expect(r.status).toBe("on_hold");
    expect(r.matched).toBe("none");
  });
});

// ───────────────────────────────────────────────────────────────
// Event ordering — the out-of-order webhook problem
// ───────────────────────────────────────────────────────────────
describe("isStatusRegression", () => {
  it("rejects a stale event arriving after a later one", () => {
    expect(isStatusRegression("out_for_delivery", "in_transit")).toBe(true);
  });

  it("never reopens a delivered shipment", () => {
    // A retried webhook must not re-fire customer notifications or
    // put a completed order back into the fulfilment queue.
    for (const stale of ["in_transit", "out_for_delivery", "picked_up"] as const) {
      expect(isStatusRegression("delivered", stale)).toBe(true);
    }
  });

  it("treats duplicates as regressions", () => {
    expect(isStatusRegression("in_transit", "in_transit")).toBe(true);
  });

  it("allows genuine backward transitions", () => {
    expect(isStatusRegression("out_for_delivery", "delivery_failed")).toBe(false);
    expect(isStatusRegression("in_transit", "on_hold")).toBe(false);
    expect(isStatusRegression("delivery_failed", "rto_initiated")).toBe(false);
    expect(isStatusRegression("out_for_delivery", "lost")).toBe(false);
    expect(isStatusRegression("manifested", "cancelled")).toBe(false);
  });

  it("allows normal forward progress", () => {
    expect(isStatusRegression("picked_up", "in_transit")).toBe(false);
    expect(isStatusRegression("out_for_delivery", "delivered")).toBe(false);
    expect(isStatusRegression("rto_initiated", "rto_delivered")).toBe(false);
  });
});

describe("eventSignature", () => {
  it("dedupes an event resent within the same minute", () => {
    const a = eventSignature({
      awb: "X1",
      rawStatus: "In Transit",
      occurredAt: new Date("2026-01-01T10:00:05Z"),
    });
    const b = eventSignature({
      awb: "X1",
      rawStatus: "in-transit",
      occurredAt: new Date("2026-01-01T10:00:47Z"),
    });
    expect(a).toBe(b);
  });

  it("keeps genuinely different events distinct", () => {
    const a = eventSignature({
      awb: "X1",
      rawStatus: "In Transit",
      occurredAt: new Date("2026-01-01T10:00:00Z"),
    });
    const b = eventSignature({
      awb: "X1",
      rawStatus: "In Transit",
      occurredAt: new Date("2026-01-01T14:00:00Z"),
    });
    expect(a).not.toBe(b);
  });
});

// ───────────────────────────────────────────────────────────────
// Billable weight
// ───────────────────────────────────────────────────────────────
describe("volumetric weight", () => {
  it("computes (L×W×H)/divisor in grams", () => {
    // 30×20×10 cm ÷ 5000 = 1.2 kg
    expect(
      volumetricWeightGrams({ lengthMm: 300, widthMm: 200, heightMm: 100 }, 5000),
    ).toBe(1200);
  });

  it("charges volumetric weight for bulky-light parcels", () => {
    // A 400g pillow in a big box bills at 1.2kg, not 400g. Quoting on
    // dead weight alone under-prices most apparel and homeware.
    const w = computeBillableWeight(
      {
        deadWeightGrams: 400,
        dimensions: { lengthMm: 300, widthMm: 200, heightMm: 100 },
        declaredValuePaise: 100_000,
        pieces: 1,
      },
      { volumetricDivisor: 5000, weightSlabGrams: 500 },
    );

    expect(w.basis).toBe("volumetric");
    expect(w.chargeableWeightGrams).toBe(1200);
    expect(w.billableWeightGrams).toBe(1500); // rounded up to the slab
  });

  it("charges dead weight for dense parcels", () => {
    const w = computeBillableWeight(
      {
        deadWeightGrams: 3000,
        dimensions: { lengthMm: 100, widthMm: 100, heightMm: 100 },
        declaredValuePaise: 100_000,
        pieces: 1,
      },
      { volumetricDivisor: 5000, weightSlabGrams: 500 },
    );
    expect(w.basis).toBe("dead");
    expect(w.billableWeightGrams).toBe(3000);
  });

  it("respects a carrier's non-standard divisor", () => {
    // A divisor of 4000 bills the same parcel heavier than 5000 does.
    const pkg = {
      deadWeightGrams: 100,
      dimensions: { lengthMm: 300, widthMm: 200, heightMm: 100 },
      declaredValuePaise: 0,
      pieces: 1,
    };
    const a = computeBillableWeight(pkg, { volumetricDivisor: 5000, weightSlabGrams: 500 });
    const b = computeBillableWeight(pkg, { volumetricDivisor: 4000, weightSlabGrams: 500 });
    expect(b.chargeableWeightGrams).toBeGreaterThan(a.chargeableWeightGrams);
  });
});

describe("assessWeightDiscrepancy", () => {
  it("ignores scale variance within tolerance", () => {
    const v = assessWeightDiscrepancy({
      declaredBillableGrams: 1000,
      carrierWeighedGrams: 1040,
      hasCarrierEvidence: true,
    });
    expect(v.disputable).toBe(false);
  });

  it("flags a large excess for dispute", () => {
    const v = assessWeightDiscrepancy({
      declaredBillableGrams: 1000,
      carrierWeighedGrams: 2500,
      hasCarrierEvidence: true,
    });
    expect(v.disputable).toBe(true);
    expect(v.excessGrams).toBe(1500);
  });

  it("treats missing carrier evidence as the strongest dispute ground", () => {
    const v = assessWeightDiscrepancy({
      declaredBillableGrams: 1000,
      carrierWeighedGrams: 2500,
      hasCarrierEvidence: false,
    });
    expect(v.disputable).toBe(true);
    expect(v.reason).toMatch(/no carrier evidence/i);
  });

  it("never flags a credit as a dispute", () => {
    const v = assessWeightDiscrepancy({
      declaredBillableGrams: 2000,
      carrierWeighedGrams: 1500,
      hasCarrierEvidence: true,
    });
    expect(v.disputable).toBe(false);
    expect(v.excessGrams).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────
// Carrier selection
// ───────────────────────────────────────────────────────────────
function quote(over: Partial<ServiceabilityQuote>): ServiceabilityQuote {
  return {
    carrier: "delhivery",
    serviceCode: "surface",
    serviceLabel: "Surface",
    freightPaise: 5000,
    codFeePaise: 0,
    totalPaise: 5000,
    billableWeightGrams: 500,
    estimatedDays: 4,
    codSupported: true,
    ...over,
  };
}

describe("selectCarrier", () => {
  it("returns nothing when there are no quotes", () => {
    expect(selectCarrier([]).chosen).toBeNull();
  });

  it("cheapest picks the lowest total", () => {
    const r = selectCarrier(
      [
        quote({ carrier: "delhivery", totalPaise: 7000 }),
        quote({ carrier: "xpressbees", totalPaise: 4500 }),
        quote({ carrier: "bluedart", totalPaise: 9000 }),
      ],
      { strategy: "cheapest" },
    );
    expect(r.chosen?.carrier).toBe("xpressbees");
  });

  it("fastest picks the fewest days, cost breaking ties", () => {
    const r = selectCarrier(
      [
        quote({ carrier: "delhivery", estimatedDays: 4, totalPaise: 4000 }),
        quote({ carrier: "bluedart", estimatedDays: 1, totalPaise: 9000 }),
        quote({ carrier: "ekart", estimatedDays: 1, totalPaise: 7000 }),
      ],
      { strategy: "fastest" },
    );
    expect(r.chosen?.carrier).toBe("ekart");
  });

  it("preferred follows the merchant's order and still falls back", () => {
    const r = selectCarrier(
      [
        quote({ carrier: "xpressbees", totalPaise: 3000 }),
        quote({ carrier: "ekart", totalPaise: 8000 }),
      ],
      { strategy: "preferred", preferredOrder: ["ekart", "delhivery"] },
    );
    // Chosen despite being nearly three times the price — that is what
    // "preferred" means, and merchants have contractual reasons for it.
    expect(r.chosen?.carrier).toBe("ekart");
    // The unlisted carrier is still ranked, so a preferred carrier
    // going down does not block the shipment.
    expect(r.ranked).toHaveLength(2);
  });

  it("balanced prices in RTO risk, not just freight", () => {
    // The cheap carrier fails 30% of the time on this lane. One RTO
    // costs more than the ₹20 saved on twenty shipments.
    const r = selectCarrier(
      [
        quote({ carrier: "xpressbees", totalPaise: 4000, performanceScore: 0.7 }),
        quote({ carrier: "delhivery", totalPaise: 6000, performanceScore: 0.98 }),
      ],
      { strategy: "balanced", dayValuePaise: 0 },
    );
    expect(r.chosen?.carrier).toBe("delhivery");
  });

  it("balanced still prefers cheap when reliability is equal", () => {
    const r = selectCarrier(
      [
        quote({ carrier: "xpressbees", totalPaise: 4000, performanceScore: 0.95 }),
        quote({ carrier: "delhivery", totalPaise: 6000, performanceScore: 0.95 }),
      ],
      { strategy: "balanced", dayValuePaise: 0 },
    );
    expect(r.chosen?.carrier).toBe("xpressbees");
  });

  it("excludes carriers that cannot do COD on a COD order", () => {
    const r = selectCarrier(
      [
        quote({ carrier: "xpressbees", totalPaise: 3000, codSupported: false }),
        quote({ carrier: "delhivery", totalPaise: 6000, codSupported: true }),
      ],
      { strategy: "cheapest" },
      { paymentModeCod: true },
    );
    expect(r.chosen?.carrier).toBe("delhivery");
    expect(r.rejected[0]?.reason).toMatch(/COD/i);
  });

  it("honours exclusions, SLA caps and performance floors", () => {
    const r = selectCarrier(
      [
        quote({ carrier: "xpressbees", totalPaise: 1000 }),
        quote({ carrier: "dtdc", totalPaise: 2000, estimatedDays: 12 }),
        quote({ carrier: "shiprocket", totalPaise: 3000, performanceScore: 0.4 }),
        quote({ carrier: "delhivery", totalPaise: 8000, performanceScore: 0.95 }),
      ],
      {
        strategy: "cheapest",
        excludeCarriers: ["xpressbees"],
        maxEstimatedDays: 7,
        minPerformanceScore: 0.6,
      },
    );
    expect(r.chosen?.carrier).toBe("delhivery");
    expect(r.rejected).toHaveLength(3);
  });

  it("reports why nothing could be chosen", () => {
    const r = selectCarrier(
      [quote({ carrier: "dtdc", estimatedDays: 20 })],
      { strategy: "cheapest", maxEstimatedDays: 5 },
    );
    expect(r.chosen).toBeNull();
    expect(r.rejected[0]?.reason).toMatch(/too slow/i);
  });

  it("is deterministic when scores tie", () => {
    const quotes = [
      quote({ carrier: "ekart", totalPaise: 5000 }),
      quote({ carrier: "dtdc", totalPaise: 5000 }),
    ];
    const a = selectCarrier(quotes, { strategy: "cheapest" }).chosen?.carrier;
    const b = selectCarrier([...quotes].reverse(), { strategy: "cheapest" }).chosen?.carrier;
    // Without a stable tiebreak, ranking flips between runs and lane
    // performance data never accumulates for either carrier.
    expect(a).toBe(b);
  });
});

describe("laneSuccessScore", () => {
  it("returns a neutral prior with no history", () => {
    expect(laneSuccessScore({ delivered: 0, rto: 0, lost: 0 })).toBe(0.9);
  });

  it("does not award a perfect score on a tiny sample", () => {
    // Three successes must not let a new carrier monopolise a lane.
    expect(laneSuccessScore({ delivered: 3, rto: 0, lost: 0 })).toBeLessThan(1);
  });

  it("converges towards the true rate with volume", () => {
    const score = laneSuccessScore({ delivered: 900, rto: 100, lost: 0 });
    expect(score).toBeGreaterThan(0.88);
    expect(score).toBeLessThan(0.92);
  });

  it("punishes a bad lane", () => {
    expect(laneSuccessScore({ delivered: 40, rto: 60, lost: 0 })).toBeLessThan(0.55);
  });
});
