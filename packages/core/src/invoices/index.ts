import { INVOICE_DOC_TYPES } from "@platform/db/schema";
import type { InvoiceDocType, TaxRegistrationType } from "@platform/db/schema";

import { docTypeFor } from "../tax/index";

/**
 * Invoices — PURE barrel, safe for client bundles (the shared
 * <InvoiceDocument> render component imports these types). Values come
 * from `@platform/db/schema`, which carries no postgres driver — the
 * root `@platform/db` barrel does and must never be imported here.
 *
 * S0 SCHEMA SPINE: signatures FROZEN; bodies implemented by lot B1.
 */

export { INVOICE_DOC_TYPES, docTypeFor };
export type { InvoiceDocType };

/** 'INV' (tax invoice) | 'BOS' (bill of supply) — invoice_series.series_code. */
export type InvoiceSeriesCode = "INV" | "BOS";

/** store_settings key that seeds new invoice_series rows. */
export const INVOICE_PREFIX_KEY = "invoicing.prefix";

/** Seller block snapshot, frozen at issue (invoices.seller JSONB). */
export type InvoiceSeller = {
  legalName: string;
  gstin: string | null;
  address: string;
  stateCode: string;
  taxRegistrationType: TaxRegistrationType;
};

/** Buyer block snapshot, frozen at issue (invoices.buyer JSONB). */
export type InvoiceBuyer = {
  name: string;
  phone: string;
  email?: string | null;
  gstin?: string | null;
  shippingAddress: {
    line1: string;
    line2?: string | null;
    city: string;
    stateCode: string;
    pincode: string;
  };
};

/** One rendered line of the document (invoices.lines JSONB element). */
export type InvoiceDocLine = {
  kind: "item" | "shipping";
  titleSnapshot: string;
  skuSnapshot: string;
  hsnSnapshot: string | null;
  quantity: number;
  unitPricePaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxRateBps: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  position: number;
};

/**
 * The render view-model: one invoices row, zero joins — the JSONB
 * snapshot IS the document. Used by both the console print page and the
 * guest order page.
 */
export type InvoiceDoc = {
  id: string;
  orderId: string;
  docType: InvoiceDocType;
  seriesCode: string;
  financialYear: string;
  number: number;
  invoiceNumber: string;
  issuedAt: Date;
  seller: InvoiceSeller;
  buyer: InvoiceBuyer;
  placeOfSupply: string;
  lines: InvoiceDocLine[];
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  currency: string;
  /** Phase 3 e-invoicing; render the IRN/QR block only when non-null. */
  irn: string | null;
  irnQr: string | null;
};

/** Minimum digits in the rendered number: 'INV/2026-27/0042'. */
export const INVOICE_NUMBER_PAD = 4;

/** Renders '{prefix}/{FY}/{padded number}', frozen at issue. */
export function formatInvoiceNumber(
  prefix: string,
  financialYear: string,
  number: number,
): string {
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`formatInvoiceNumber: number must be a non-negative integer, got ${number}`);
  }
  return `${prefix}/${financialYear}/${String(number).padStart(INVOICE_NUMBER_PAD, "0")}`;
}

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
] as const;

const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
] as const;

/** 1–99 → 'Seven' | 'Nineteen' | 'Twenty-One' | 'Ninety'. */
function twoDigitWords(n: number): string {
  if (n < 20) return ONES[n] as string;
  const tens = TENS[Math.trunc(n / 10)] as string;
  const ones = n % 10;
  return ones === 0 ? tens : `${tens}-${ONES[ones]}`;
}

/** 1–999. */
function threeDigitWords(n: number): string {
  const hundreds = Math.trunc(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest > 0) parts.push(twoDigitWords(rest));
  return parts.join(" ");
}

/** Indian-system words for n ≥ 1: crore / lakh / thousand / hundred. */
function indianWords(n: number): string {
  if (n >= 10_000_000) {
    const crore = Math.trunc(n / 10_000_000);
    const rest = n % 10_000_000;
    const head = `${indianWords(crore)} Crore`;
    return rest > 0 ? `${head} ${indianWords(rest)}` : head;
  }
  const parts: string[] = [];
  const lakh = Math.trunc(n / 100_000);
  if (lakh > 0) parts.push(`${twoDigitWords(lakh)} Lakh`);
  const thousand = Math.trunc((n % 100_000) / 1000);
  if (thousand > 0) parts.push(`${twoDigitWords(thousand)} Thousand`);
  const rest = n % 1000;
  if (rest > 0) parts.push(threeDigitWords(rest));
  return parts.join(" ");
}

/** Indian-system amount in words for the invoice footer (unit-tested, D19/§8). */
export function amountInWords(amountPaise: number): string {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) {
    throw new Error(
      `amountInWords: amount must be a non-negative integer in paise, got ${amountPaise}`,
    );
  }
  const rupees = Math.trunc(amountPaise / 100);
  const paise = amountPaise % 100;
  if (rupees === 0 && paise === 0) return "Zero Rupees Only";
  const rupeeUnit = rupees === 1 ? "Rupee" : "Rupees";
  const paisaUnit = paise === 1 ? "Paisa" : "Paise";
  if (rupees === 0) return `${twoDigitWords(paise)} ${paisaUnit} Only`;
  if (paise === 0) return `${indianWords(rupees)} ${rupeeUnit} Only`;
  return `${indianWords(rupees)} ${rupeeUnit} and ${twoDigitWords(paise)} ${paisaUnit} Only`;
}
