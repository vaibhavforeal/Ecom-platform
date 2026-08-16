import { and, desc, eq, invoiceSeries, invoices, sql, withTenant } from "@platform/db";
import type { InvoiceDocType, Tx } from "@platform/db";

import { AppError } from "../errors";
import { financialYearOf } from "../tax/index";
import { formatInvoiceNumber } from "./index";
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Get-or-create the (series, FY) counter row (INSERT .. ON CONFLICT DO
 * NOTHING, the ensureDefaultLocation shape), then allocate via
 * UPDATE .. RETURNING. In-tx only — called only by checkout/server
 * inside the confirming transaction.
 */
export async function allocateInvoiceNumber(
  tx: Tx,
  tenantId: string,
  args: { seriesCode: InvoiceSeriesCode; financialYear: string; prefix: string },
): Promise<{ number: number; invoiceNumber: string }> {
  // Lazy series creation, race-safe: the loser of a concurrent first
  // allocation no-ops here and both serialize on the UPDATE's row lock.
  await tx
    .insert(invoiceSeries)
    .values({
      tenantId,
      seriesCode: args.seriesCode,
      financialYear: args.financialYear,
      prefix: args.prefix,
    })
    .onConflictDoNothing();

  // The allocation. UPDATE .. RETURNING is atomic and transactional: a
  // rollback of the confirming tx returns the number, so the series stays
  // gap-free. Never MAX+1, never a SEQUENCE.
  const [row] = await tx
    .update(invoiceSeries)
    .set({ nextNumber: sql`${invoiceSeries.nextNumber} + 1` })
    .where(
      and(
        eq(invoiceSeries.tenantId, tenantId),
        eq(invoiceSeries.seriesCode, args.seriesCode),
        eq(invoiceSeries.financialYear, args.financialYear),
      ),
    )
    .returning({ nextNumber: invoiceSeries.nextNumber, prefix: invoiceSeries.prefix });

  if (!row) {
    // Unreachable after the upsert unless the tx lacks tenant context
    // (FORCE RLS silently matches zero rows) — fail loudly, not with a
    // phantom number.
    throw new Error(
      `invoice_series (${args.seriesCode}, ${args.financialYear}) missing after upsert — is the transaction missing tenant context?`,
    );
  }

  const number = row.nextNumber - 1;
  // The series row's prefix wins: it was frozen when the (series, FY) row
  // was first created, so a later settings change never forks numbering
  // mid-year.
  return { number, invoiceNumber: formatInvoiceNumber(row.prefix, args.financialYear, number) };
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

const SERIES_FOR_DOC_TYPE: Record<InvoiceDocType, InvoiceSeriesCode> = {
  tax_invoice: "INV",
  bill_of_supply: "BOS",
};

/**
 * Allocates the number (allocateInvoiceNumber) and INSERTs the
 * self-contained invoices row, all inside the CALLER's confirming tx.
 * The invoices_order_doc_key unique makes a replayed confirmation
 * collide instead of double-issuing.
 */
export async function createInvoice(
  tx: Tx,
  tenantId: string,
  input: CreateInvoiceInput,
): Promise<{ invoiceId: string; invoiceNumber: string }> {
  const issues: { path: string; message: string }[] = [];
  if (input.lines.length === 0) {
    issues.push({ path: "lines", message: "An invoice must carry at least one line." });
  }
  for (const [field, value] of [
    ["subtotalPaise", input.subtotalPaise],
    ["discountPaise", input.discountPaise],
    ["taxablePaise", input.taxablePaise],
    ["cgstPaise", input.cgstPaise],
    ["sgstPaise", input.sgstPaise],
    ["igstPaise", input.igstPaise],
    ["totalPaise", input.totalPaise],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      issues.push({ path: field, message: "Must be a non-negative integer amount in paise." });
    }
  }
  // A Bill of Supply never carries tax — unregistered/composition sellers
  // cannot collect GST (§6.1); catching it here beats issuing an illegal
  // document.
  if (
    input.docType === "bill_of_supply" &&
    input.cgstPaise + input.sgstPaise + input.igstPaise !== 0
  ) {
    issues.push({ path: "docType", message: "A Bill of Supply cannot carry GST amounts." });
  }
  if (issues.length > 0) {
    throw new AppError({
      code: "invalid_payload",
      message: `Invalid invoice input: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      status: 422,
      publicMessage: "Invalid invoice input.",
      details: { issues },
    });
  }

  const seriesCode = SERIES_FOR_DOC_TYPE[input.docType];
  const financialYear = financialYearOf(new Date());
  const { number, invoiceNumber } = await allocateInvoiceNumber(tx, tenantId, {
    seriesCode,
    financialYear,
    prefix: input.prefix,
  });

  const [row] = await tx
    .insert(invoices)
    .values({
      tenantId,
      orderId: input.orderId,
      docType: input.docType,
      seriesCode,
      financialYear,
      number,
      invoiceNumber,
      seller: input.seller,
      buyer: input.buyer,
      placeOfSupply: input.placeOfSupply,
      lines: input.lines,
      subtotalPaise: input.subtotalPaise,
      discountPaise: input.discountPaise,
      taxablePaise: input.taxablePaise,
      cgstPaise: input.cgstPaise,
      sgstPaise: input.sgstPaise,
      igstPaise: input.igstPaise,
      totalPaise: input.totalPaise,
      currency: input.currency ?? "INR",
    })
    .returning({ id: invoices.id });

  if (!row) throw new Error("invoices INSERT returned no row");
  return { invoiceId: row.id, invoiceNumber };
}

/** One SELECT, zero joins — the JSONB snapshot is the whole document. */
export async function getInvoiceForRender(
  tenantId: string,
  orderId: string,
): Promise<InvoiceDoc | null> {
  // A malformed id is "no such invoice", not a Postgres cast error.
  if (!UUID_RE.test(orderId)) return null;

  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.orderId, orderId)))
      .orderBy(desc(invoices.issuedAt))
      .limit(1);
    if (!row) return null;

    return {
      id: row.id,
      orderId: row.orderId,
      docType: row.docType,
      seriesCode: row.seriesCode,
      financialYear: row.financialYear,
      number: row.number,
      invoiceNumber: row.invoiceNumber,
      issuedAt: row.issuedAt,
      seller: row.seller as InvoiceSeller,
      buyer: row.buyer as InvoiceBuyer,
      placeOfSupply: row.placeOfSupply,
      lines: row.lines as InvoiceDocLine[],
      subtotalPaise: row.subtotalPaise,
      discountPaise: row.discountPaise,
      taxablePaise: row.taxablePaise,
      cgstPaise: row.cgstPaise,
      sgstPaise: row.sgstPaise,
      igstPaise: row.igstPaise,
      totalPaise: row.totalPaise,
      currency: row.currency,
      irn: row.irn,
      irnQr: row.irnQr,
    };
  });
}
