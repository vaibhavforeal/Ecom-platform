import type { InvoiceDocType, TaxRegistrationType } from "@platform/db/schema";

/**
 * GST engine — PURE barrel, safe for client bundles. No DB, no env, no
 * hidden Date.now() (the clock is passed in).
 *
 * S0 SCHEMA SPINE: signatures are FROZEN (PHASE2_COMMERCE_DESIGN.md §6.1);
 * bodies are implemented by lot B1. Rules the implementation must encode:
 * unregistered/composition → all zeros (Bill of Supply, even with a buyer
 * GSTIN); intra-state (seller === place of supply) → sum-invariant
 * odd-paise split (D18): cgst = HALF_UP(tax/2), sgst = tax − cgst;
 * inter-state → IGST at the full rate; inclusive extraction
 * tax = gross × r / (10000 + r) rounded HALF_UP PER LINE then summed —
 * never sum-then-round; exclusive tax = base × r / 10000. Discounts are
 * applied BEFORE tax. Integer math only.
 */

export type { TaxRegistrationType };

export type TaxableLine = {
  lineId: string;
  /** Post-discount; inclusive OR exclusive per ctx flag. */
  taxablePaise: number;
  /** 0 | 500 | 1200 | 1800 | 2800 … */
  taxRateBps: number;
};

export type TaxContext = {
  /** tenants.origin_state_code. */
  sellerStateCode: string;
  /** Delivery address state (cross-checked against pincode prefix, D3). */
  placeOfSupplyStateCode: string;
  registrationType: TaxRegistrationType;
  /** Default true (locked decision: tax-inclusive pricing). */
  inclusive: boolean;
};

export type LineTax = {
  lineId: string;
  /** Base after inclusive extraction. */
  taxableExclusivePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
};

export function computeLineTaxes(_lines: TaxableLine[], _ctx: TaxContext): LineTax[] {
  throw new Error("S0 stub: implemented by lot B1");
}

/** Indian financial year of an instant, e.g. '2026-27'. IST boundary, not UTC. */
export function financialYearOf(_at: Date, _tz?: "Asia/Kolkata"): string {
  throw new Error("S0 stub: implemented by lot B1");
}

/** Which document a tenant may issue: Bill of Supply unless GST-regular. */
export function docTypeFor(_reg: TaxRegistrationType): InvoiceDocType {
  throw new Error("S0 stub: implemented by lot B1");
}

/** Integer-only HALF_UP division (away from zero at exactly .5). */
export function roundHalfUp(_numer: number, _denom: number): number {
  throw new Error("S0 stub: implemented by lot B1");
}

/**
 * Largest-remainder allocation: sum(out) === totalPaise EXACTLY; spreads
 * an order-level discount across lines pre-tax. A zero-weight line gets 0.
 */
export function allocateProportionally(_totalPaise: number, _weights: number[]): number[] {
  throw new Error("S0 stub: implemented by lot B1");
}
