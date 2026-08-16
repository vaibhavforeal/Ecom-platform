import type { InvoiceDocType, TaxRegistrationType } from "@platform/db/schema";

import { AppError } from "../errors";

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

/**
 * HALF_UP division on bigints (away from zero at exactly .5), returning
 * a plain number. All money math routes through here so that even a
 * numerator like max-money × rate-bps — which can exceed
 * Number.MAX_SAFE_INTEGER as a float product — is exact.
 */
function divHalfUp(numer: bigint, denom: bigint): number {
  const negative = numer < 0n !== denom < 0n;
  const n = numer < 0n ? -numer : numer;
  const d = denom < 0n ? -denom : denom;
  const q = n / d;
  const r = n % d;
  const magnitude = r * 2n >= d ? q + 1n : q;
  const out = Number(negative ? -magnitude : magnitude);
  if (!Number.isSafeInteger(out)) {
    throw new Error(`divHalfUp: result ${negative ? "-" : ""}${magnitude} exceeds safe integer range`);
  }
  return out;
}

/** Integer-only HALF_UP division (away from zero at exactly .5). */
export function roundHalfUp(numer: number, denom: number): number {
  if (!Number.isSafeInteger(numer)) {
    throw new Error(`roundHalfUp: numerator must be a safe integer, got ${numer}`);
  }
  if (!Number.isSafeInteger(denom) || denom === 0) {
    throw new Error(`roundHalfUp: denominator must be a non-zero safe integer, got ${denom}`);
  }
  return divHalfUp(BigInt(numer), BigInt(denom));
}

/** GST state codes compare after trim + uppercase ('29 ' === '29', 'ka' === 'KA'). */
function normalizeStateCode(code: string): string {
  return code.trim().toUpperCase();
}

function invalidPayload(issues: { path: string; message: string }[]): AppError {
  return new AppError({
    code: "invalid_payload",
    message: `Invalid tax input: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    status: 422,
    publicMessage: "Invalid input.",
    details: { issues },
  });
}

export function computeLineTaxes(lines: TaxableLine[], ctx: TaxContext): LineTax[] {
  const issues: { path: string; message: string }[] = [];
  lines.forEach((line, i) => {
    if (!Number.isSafeInteger(line.taxablePaise) || line.taxablePaise < 0) {
      issues.push({
        path: `lines[${i}].taxablePaise`,
        message: "Must be a non-negative integer amount in paise.",
      });
    }
    if (!Number.isSafeInteger(line.taxRateBps) || line.taxRateBps < 0) {
      issues.push({
        path: `lines[${i}].taxRateBps`,
        message: "Must be a non-negative integer rate in basis points.",
      });
    }
  });
  if (issues.length > 0) throw invalidPayload(issues);

  // Unregistered and composition tenants issue a Bill of Supply and
  // charge no GST — all zeros even when the line carries a rate and the
  // buyer presents a GSTIN.
  const charged = ctx.registrationType === "regular";
  const intraState =
    normalizeStateCode(ctx.sellerStateCode) === normalizeStateCode(ctx.placeOfSupplyStateCode);

  return lines.map((line) => {
    if (!charged || line.taxRateBps === 0 || line.taxablePaise === 0) {
      // Nothing extracted: the base is the amount as given. Zero-rate
      // (exempt) lines still appear on the invoice — the caller keeps them.
      return {
        lineId: line.lineId,
        taxableExclusivePaise: line.taxablePaise,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: 0,
        taxPaise: 0,
      };
    }

    // Rounded HALF_UP PER LINE; the caller sums line results — never
    // sum-then-round (the two diverge; see the D20 pinned vector).
    const gross = BigInt(line.taxablePaise);
    const rate = BigInt(line.taxRateBps);
    const taxPaise = ctx.inclusive
      ? divHalfUp(gross * rate, 10000n + rate) // tax = gross × r / (10000 + r)
      : divHalfUp(gross * rate, 10000n); //       tax = base  × r / 10000

    // D18 sum-invariant odd-paise split: cgst + sgst === tax ALWAYS.
    let cgstPaise = 0;
    let sgstPaise = 0;
    let igstPaise = 0;
    if (intraState) {
      cgstPaise = divHalfUp(BigInt(taxPaise), 2n);
      sgstPaise = taxPaise - cgstPaise;
    } else {
      igstPaise = taxPaise;
    }

    return {
      lineId: line.lineId,
      taxableExclusivePaise: ctx.inclusive ? line.taxablePaise - taxPaise : line.taxablePaise,
      cgstPaise,
      sgstPaise,
      igstPaise,
      taxPaise,
    };
  });
}

/** IST is a fixed UTC+05:30 — no DST, so the offset shift is exact. */
const IST_OFFSET_MS = 330 * 60 * 1000;

/** Indian financial year of an instant, e.g. '2026-27'. IST boundary, not UTC. */
export function financialYearOf(at: Date, _tz: "Asia/Kolkata" = "Asia/Kolkata"): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new Error("financialYearOf: invalid Date");
  }
  // Shift the instant by +05:30 and read calendar fields as UTC: the FY
  // flips at midnight Apr 1 IST (2026-03-31T18:30:00Z), not midnight UTC.
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth(); // 0-based; April = 3
  const startYear = month >= 3 ? year : year - 1;
  const endYY = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endYY}`;
}

/** Which document a tenant may issue: Bill of Supply unless GST-regular. */
export function docTypeFor(reg: TaxRegistrationType): InvoiceDocType {
  switch (reg) {
    case "regular":
      return "tax_invoice";
    case "unregistered":
    case "composition":
      return "bill_of_supply";
    default: {
      // Registration type comes off a DB row at runtime; refuse loudly
      // rather than silently issuing the wrong document.
      const never: never = reg;
      throw new Error(`docTypeFor: unknown tax registration type ${String(never)}`);
    }
  }
}

/**
 * Largest-remainder allocation: sum(out) === totalPaise EXACTLY; spreads
 * an order-level discount across lines pre-tax. A zero-weight line gets 0.
 */
export function allocateProportionally(totalPaise: number, weights: number[]): number[] {
  const issues: { path: string; message: string }[] = [];
  if (!Number.isSafeInteger(totalPaise) || totalPaise < 0) {
    issues.push({ path: "totalPaise", message: "Must be a non-negative integer amount in paise." });
  }
  weights.forEach((w, i) => {
    if (!Number.isSafeInteger(w) || w < 0) {
      issues.push({ path: `weights[${i}]`, message: "Must be a non-negative integer weight." });
    }
  });
  if (issues.length > 0) throw invalidPayload(issues);

  const totalWeight = weights.reduce((sum, w) => sum + BigInt(w), 0n);
  if (totalWeight === 0n) {
    if (totalPaise === 0) return weights.map(() => 0);
    throw invalidPayload([
      { path: "weights", message: "Cannot allocate a non-zero amount over all-zero weights." },
    ]);
  }

  const total = BigInt(totalPaise);
  const shares: number[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let allocated = 0n;
  weights.forEach((weight, index) => {
    const numer = total * BigInt(weight);
    const share = numer / totalWeight;
    shares.push(Number(share));
    remainders.push({ index, remainder: numer % totalWeight });
    allocated += share;
  });

  // Hand the leftover paise, one each, to the largest remainders (earlier
  // lines win ties). A zero-weight line has remainder 0 and — since more
  // lines than `leftover` carry a non-zero remainder — never gets one.
  const leftover = Number(total - allocated);
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (let i = 0; i < leftover; i++) {
    const index = remainders[i]!.index;
    shares[index] = (shares[index] ?? 0) + 1;
  }
  return shares;
}
