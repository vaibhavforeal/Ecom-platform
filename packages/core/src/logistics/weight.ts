import type { CarrierCapabilities, Dimensions, PackageSpec } from "./types";

/**
 * Billable weight.
 *
 * Carriers do not bill what the parcel weighs. They bill
 * `max(dead weight, volumetric weight)`, rounded up to a slab — and the
 * volumetric divisor and slab size differ per carrier. A merchant
 * quoting on dead weight alone will under-price every bulky-light
 * parcel they ship, which is most of apparel and homeware.
 *
 * Then, separately, the carrier re-weighs at its hub and bills the
 * difference. Unchallenged weight discrepancies are one of the largest
 * silent cost leaks in Indian e-commerce, which is why this file also
 * exists to detect them.
 */

/** Volumetric weight in grams: (L × W × H in cm) / divisor, as kg → g. */
export function volumetricWeightGrams(dims: Dimensions, divisor: number): number {
  if (divisor <= 0) throw new Error("volumetricDivisor must be positive");

  const lCm = dims.lengthMm / 10;
  const wCm = dims.widthMm / 10;
  const hCm = dims.heightMm / 10;

  return Math.ceil(((lCm * wCm * hCm) / divisor) * 1000);
}

/** Round up to the carrier's billing slab. */
export function applySlab(grams: number, slabGrams: number): number {
  if (slabGrams <= 0) return grams;
  return Math.ceil(grams / slabGrams) * slabGrams;
}

export type BillableWeight = {
  deadWeightGrams: number;
  volumetricWeightGrams: number;
  /** Whichever of the two the carrier will actually charge on. */
  chargeableWeightGrams: number;
  /** After slab rounding — the number that appears on the invoice. */
  billableWeightGrams: number;
  basis: "dead" | "volumetric";
};

export function computeBillableWeight(
  pkg: PackageSpec,
  caps: Pick<CarrierCapabilities, "volumetricDivisor" | "weightSlabGrams">,
): BillableWeight {
  const volumetric = volumetricWeightGrams(pkg.dimensions, caps.volumetricDivisor);
  const dead = pkg.deadWeightGrams;
  const chargeable = Math.max(dead, volumetric);

  return {
    deadWeightGrams: dead,
    volumetricWeightGrams: volumetric,
    chargeableWeightGrams: chargeable,
    billableWeightGrams: applySlab(chargeable, caps.weightSlabGrams),
    basis: volumetric > dead ? "volumetric" : "dead",
  };
}

/**
 * Did the carrier's re-weigh justify the extra charge?
 *
 * Scales disagree by small amounts legitimately, so a tolerance avoids
 * drowning the merchant in noise. Beyond it, the discrepancy is worth a
 * human look — carriers routinely apply these silently, and they are
 * only refundable if disputed within the carrier's window.
 */
export type DiscrepancyVerdict = {
  disputable: boolean;
  excessGrams: number;
  reason: string;
};

const TOLERANCE_GRAMS = 50;
const TOLERANCE_RATIO = 0.05; // 5%

export function assessWeightDiscrepancy(input: {
  declaredBillableGrams: number;
  carrierWeighedGrams: number;
  hasCarrierEvidence: boolean;
}): DiscrepancyVerdict {
  const excess = input.carrierWeighedGrams - input.declaredBillableGrams;

  if (excess <= 0) {
    return { disputable: false, excessGrams: 0, reason: "No excess charged." };
  }

  const tolerance = Math.max(TOLERANCE_GRAMS, input.declaredBillableGrams * TOLERANCE_RATIO);
  if (excess <= tolerance) {
    return {
      disputable: false,
      excessGrams: excess,
      reason: `Within tolerance (${Math.round(tolerance)}g) — scale variance, not worth disputing.`,
    };
  }

  // No image or weighing evidence means the carrier cannot substantiate
  // the charge, which is the strongest dispute position there is.
  if (!input.hasCarrierEvidence) {
    return {
      disputable: true,
      excessGrams: excess,
      reason: `${excess}g excess with no carrier evidence — dispute on lack of proof.`,
    };
  }

  return {
    disputable: true,
    excessGrams: excess,
    reason: `${excess}g excess beyond tolerance — review packing spec against carrier evidence.`,
  };
}
