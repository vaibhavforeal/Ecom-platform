import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@platform/core";
import { getInvoiceForRender } from "@platform/core/invoices/server";

import { InvoiceDocument } from "../../../../components/InvoiceDocument";
import { requireActor } from "../../../../lib/session";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The invoice print page (spec §8): one SELECT, zero joins — the JSONB
 * snapshot is the whole document. The toolbar carries the no-print class
 * so the printed page is only the document.
 */
export default async function OrderInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  if (!can(actor, "orders:read")) {
    return (
      <main>
        <h1>Invoice</h1>
        <p className="error">Your role does not include access to orders.</p>
      </main>
    );
  }

  const doc = await getInvoiceForRender(actor.tenantId, id);

  if (!doc) {
    return (
      <main>
        <nav className="crumbs no-print">
          <Link href="/orders">Orders</Link> · <Link href={`/orders/${id}`}>Order</Link>
        </nav>
        <h1>Invoice</h1>
        <div className="panel">
          <p className="muted">
            No invoice has been issued for this order yet — one is created at payment
            confirmation.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <nav className="toolbar no-print" style={{ marginBottom: 16 }}>
        <Link href={`/orders/${id}`} className="chip">
          ← Back to order
        </Link>
        <PrintButton />
      </nav>
      <InvoiceDocument doc={doc} />
    </main>
  );
}
