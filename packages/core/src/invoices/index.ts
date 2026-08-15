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

/** Renders '{prefix}/{FY}/{padded number}', frozen at issue. */
export function formatInvoiceNumber(
  _prefix: string,
  _financialYear: string,
  _number: number,
): string {
  throw new Error("S0 stub: implemented by lot B1");
}

/** Indian-system amount in words for the invoice footer (unit-tested, D19/§8). */
export function amountInWords(_amountPaise: number): string {
  throw new Error("S0 stub: implemented by lot B1");
}
