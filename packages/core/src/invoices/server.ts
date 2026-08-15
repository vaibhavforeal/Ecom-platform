import type { InvoiceDocType, Tx } from "@platform/db";

import type {
  InvoiceBuyer,
  InvoiceDoc,
  InvoiceDocLine,
  InvoiceSeller,
  InvoiceSeriesCode,
} from "./index";

/**
 * Invoices — SERVER barrel. S0 SCHEMA SPINE: signatures FROZEN; bodies
 * implemented by lot B1.
 *
 * The two write doors take the CALLER's transaction: an invoice number is
 * allocated ONLY inside the same tx as the payment/COD confirmation (a
 * rollback returns the number), ONLY at confirmation — abandoned
 * checkouts must never consume numbers. Allocation is UPDATE ..
 * SET next_number = next_number + 1 .. RETURNING next_number - 1 on
 * invoice_series, never MAX+1, never a SEQUENCE.
 */

/**
 * Get-or-create the (series, FY) counter row (INSERT .. ON CONFLICT DO
 * NOTHING, the ensureDefaultLocation shape), then allocate via
 * UPDATE .. RETURNING. In-tx only — called only by checkout/server
 * inside the confirming transaction.
 */
export async function allocateInvoiceNumber(
  _tx: Tx,
  _tenantId: string,
  _args: { seriesCode: InvoiceSeriesCode; financialYear: string; prefix: string },
): Promise<{ number: number; invoiceNumber: string }> {
  throw new Error("S0 stub: implemented by lot B1");
}

export type CreateInvoiceInput = {
  orderId: string;
  docType: InvoiceDocType;
  /** Series prefix from store_settings 'invoicing.prefix'. */
  prefix: string;
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
  currency?: string;
};

/**
 * Allocates the number (allocateInvoiceNumber) and INSERTs the
 * self-contained invoices row, all inside the CALLER's confirming tx.
 * The invoices_order_doc_key unique makes a replayed confirmation
 * collide instead of double-issuing.
 */
export async function createInvoice(
  _tx: Tx,
  _tenantId: string,
  _input: CreateInvoiceInput,
): Promise<{ invoiceId: string; invoiceNumber: string }> {
  throw new Error("S0 stub: implemented by lot B1");
}

/** One SELECT, zero joins — the JSONB snapshot is the whole document. */
export async function getInvoiceForRender(
  _tenantId: string,
  _orderId: string,
): Promise<InvoiceDoc | null> {
  throw new Error("S0 stub: implemented by lot B1");
}
