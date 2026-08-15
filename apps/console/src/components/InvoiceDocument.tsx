import { formatPaise } from "@platform/core/catalog";
import { amountInWords } from "@platform/core/invoices";
import type { InvoiceDoc, InvoiceDocLine } from "@platform/core/invoices";

/**
 * The shared invoice render (spec §8): print-CSS HTML, server component,
 * zero PDF dependency. It renders ONE invoices row — the JSONB snapshot
 * IS the document; nothing here may join to live catalog rows. Used by
 * the console print page; the storefront guest order page renders the
 * same InvoiceDoc shape (B-INT wires that side — apps cannot import each
 * other, so until a shared UI package exists the markup lives here and
 * is duplicated there if needed).
 *
 * The IRN/QR block renders only when `irn` is non-null, so Phase 3
 * e-invoicing needs zero layout rework.
 */

function label(text: string): string {
  return text.replaceAll("_", " ");
}

function rate(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/** Per-rate tax summary rows (item + shipping lines grouped by rate). */
function taxSummary(lines: InvoiceDocLine[]): {
  taxRateBps: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
}[] {
  const byRate = new Map<number, ReturnType<typeof taxSummary>[number]>();
  for (const line of lines) {
    const row =
      byRate.get(line.taxRateBps) ??
      {
        taxRateBps: line.taxRateBps,
        taxablePaise: 0,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: 0,
        taxPaise: 0,
      };
    row.taxablePaise += line.taxablePaise;
    row.cgstPaise += line.cgstPaise;
    row.sgstPaise += line.sgstPaise;
    row.igstPaise += line.igstPaise;
    row.taxPaise += line.taxPaise;
    byRate.set(line.taxRateBps, row);
  }
  return [...byRate.values()].sort((a, b) => a.taxRateBps - b.taxRateBps);
}

export function InvoiceDocument({ doc }: { doc: InvoiceDoc }) {
  const money = (paise: number) => formatPaise(paise, { currency: doc.currency });
  const title = doc.docType === "bill_of_supply" ? "Bill of Supply" : "Tax Invoice";
  const interState = doc.igstPaise > 0;
  const taxed = doc.docType === "tax_invoice";
  const lines = [...doc.lines].sort((a, b) => a.position - b.position);
  const summary = taxSummary(lines);
  const addr = doc.buyer.shippingAddress;

  return (
    <article className="invoice-doc">
      <style>{invoiceCss}</style>

      <header className="inv-head">
        <div>
          <h1>{title}</h1>
          <p>
            <strong>{doc.invoiceNumber}</strong>
            <br />
            Dated {doc.issuedAt.toLocaleDateString("en-IN")} · FY {doc.financialYear}
          </p>
        </div>
        <div className="inv-seller">
          <strong>{doc.seller.legalName}</strong>
          <br />
          {doc.seller.address}
          <br />
          State code {doc.seller.stateCode}
          {doc.seller.gstin ? (
            <>
              <br />
              GSTIN {doc.seller.gstin}
            </>
          ) : (
            <>
              <br />
              {label(doc.seller.taxRegistrationType)} — not registered for GST collection
            </>
          )}
        </div>
      </header>

      <section className="inv-parties">
        <div>
          <h2>Billed and shipped to</h2>
          <p>
            <strong>{doc.buyer.name}</strong>
            <br />
            {addr.line1}
            {addr.line2 ? (
              <>
                <br />
                {addr.line2}
              </>
            ) : null}
            <br />
            {addr.city} {addr.pincode}, state code {addr.stateCode}
            <br />
            {doc.buyer.phone}
            {doc.buyer.email ? ` · ${doc.buyer.email}` : ""}
            {doc.buyer.gstin ? (
              <>
                <br />
                GSTIN {doc.buyer.gstin}
              </>
            ) : null}
          </p>
        </div>
        <div>
          <h2>Place of supply</h2>
          <p>{doc.placeOfSupply}</p>
        </div>
      </section>

      <table className="inv-lines">
        <thead>
          <tr>
            <th>#</th>
            <th>Description</th>
            <th>HSN</th>
            <th className="num">Qty</th>
            <th className="num">Rate</th>
            <th className="num">Discount</th>
            <th className="num">Taxable</th>
            {taxed && <th className="num">GST</th>}
            {taxed &&
              (interState ? (
                <th className="num">IGST</th>
              ) : (
                <>
                  <th className="num">CGST</th>
                  <th className="num">SGST</th>
                </>
              ))}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={`${line.position}-${i}`}>
              <td>{i + 1}</td>
              <td>{line.titleSnapshot}{line.skuSnapshot ? ` (${line.skuSnapshot})` : ""}</td>
              <td>{line.hsnSnapshot ?? "—"}</td>
              <td className="num">{line.quantity}</td>
              <td className="num">{money(line.unitPricePaise)}</td>
              <td className="num">{line.discountPaise ? money(line.discountPaise) : "—"}</td>
              <td className="num">{money(line.taxablePaise)}</td>
              {taxed && <td className="num">{rate(line.taxRateBps)}</td>}
              {taxed &&
                (interState ? (
                  <td className="num">{money(line.igstPaise)}</td>
                ) : (
                  <>
                    <td className="num">{money(line.cgstPaise)}</td>
                    <td className="num">{money(line.sgstPaise)}</td>
                  </>
                ))}
              <td className="num">{money(line.totalPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {taxed && (
        <table className="inv-tax-summary">
          <caption>Tax summary by rate</caption>
          <thead>
            <tr>
              <th>Rate</th>
              <th className="num">Taxable value</th>
              {interState ? (
                <th className="num">IGST</th>
              ) : (
                <>
                  <th className="num">CGST</th>
                  <th className="num">SGST</th>
                </>
              )}
              <th className="num">Total tax</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((row) => (
              <tr key={row.taxRateBps}>
                <td>{rate(row.taxRateBps)}</td>
                <td className="num">{money(row.taxablePaise)}</td>
                {interState ? (
                  <td className="num">{money(row.igstPaise)}</td>
                ) : (
                  <>
                    <td className="num">{money(row.cgstPaise)}</td>
                    <td className="num">{money(row.sgstPaise)}</td>
                  </>
                )}
                <td className="num">{money(row.taxPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="inv-totals">
        <table>
          <tbody>
            <tr>
              <td>Subtotal (items)</td>
              <td className="num">{money(doc.subtotalPaise)}</td>
            </tr>
            {doc.discountPaise > 0 && (
              <tr>
                <td>Discount</td>
                <td className="num">− {money(doc.discountPaise)}</td>
              </tr>
            )}
            <tr>
              <td>Taxable value</td>
              <td className="num">{money(doc.taxablePaise)}</td>
            </tr>
            {taxed && !interState && (
              <>
                <tr>
                  <td>CGST</td>
                  <td className="num">{money(doc.cgstPaise)}</td>
                </tr>
                <tr>
                  <td>SGST</td>
                  <td className="num">{money(doc.sgstPaise)}</td>
                </tr>
              </>
            )}
            {taxed && interState && (
              <tr>
                <td>IGST</td>
                <td className="num">{money(doc.igstPaise)}</td>
              </tr>
            )}
            <tr className="inv-grand">
              <td>Total</td>
              <td className="num">{money(doc.totalPaise)}</td>
            </tr>
          </tbody>
        </table>
        <p className="inv-words">{amountInWords(doc.totalPaise)}</p>
      </section>

      {doc.irn && (
        <section className="inv-irn">
          <h2>e-Invoice</h2>
          <p>
            IRN <code>{doc.irn}</code>
          </p>
          {/* A plain img on purpose: next/image cannot optimize a data
              URI, and a printed QR must not be resampled anyway. */}
          {doc.irnQr?.startsWith("data:") && (
            <img className="inv-qr" src={doc.irnQr} alt="e-invoice QR code" />
          )}
        </section>
      )}

      <footer className="inv-foot">
        <p>
          {doc.docType === "bill_of_supply"
            ? "Bill of Supply — no GST charged (composition/unregistered supplier)."
            : "This is a computer-generated tax invoice."}
        </p>
      </footer>
    </article>
  );
}

/**
 * Print-first CSS: A4 page rules, tables that refuse to split across
 * pages, and everything scoped under .invoice-doc so the console chrome
 * around it stays untouched on screen.
 */
const invoiceCss = `
@page { size: A4; margin: 14mm; }
.invoice-doc {
  background: #fff; color: #111; max-width: 186mm; margin: 0 auto;
  font-size: 12px; line-height: 1.45;
}
.invoice-doc h1 { font-size: 20px; margin: 0 0 4px; }
.invoice-doc h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 4px; }
.invoice-doc table { width: 100%; border-collapse: collapse; margin: 10px 0; page-break-inside: avoid; }
.invoice-doc th, .invoice-doc td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
.invoice-doc .num { text-align: right; white-space: nowrap; }
.invoice-doc tr { page-break-inside: avoid; }
.inv-head { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid #111; padding-bottom: 8px; }
.inv-seller { text-align: right; }
.inv-parties { display: flex; justify-content: space-between; gap: 16px; margin: 10px 0; }
.inv-tax-summary caption { text-align: left; font-weight: 600; margin-bottom: 2px; }
.inv-totals { display: flex; flex-direction: column; align-items: flex-end; }
.inv-totals table { width: auto; min-width: 60mm; }
.inv-grand td { font-weight: 700; border-top: 2px solid #111; }
.inv-words { font-style: italic; margin: 4px 0 0; }
.inv-irn { page-break-inside: avoid; }
.inv-qr { width: 90px; height: 90px; }
.inv-foot { margin-top: 12px; border-top: 1px solid #999; padding-top: 6px; color: #444; }
@media print {
  .no-print, .no-print * { display: none !important; }
  .invoice-doc { max-width: none; font-size: 11px; }
}
`;
