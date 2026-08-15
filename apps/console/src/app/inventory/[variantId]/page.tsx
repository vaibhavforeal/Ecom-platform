import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@platform/core";
import { getMovements } from "@platform/core/inventory/server";
import { and, eq, isNull, products, productVariants, withTenant } from "@platform/db";
import type { StockMovementReason } from "@platform/db";

import { requireActor } from "../../../lib/session";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REASON_LABELS: Record<StockMovementReason, string> = {
  opening_balance: "opening balance",
  adjustment: "adjustment",
  sale: "sale",
};

/** The timestamped answer to "why does this say 3 when I have 5?". */
export default async function MovementHistoryPage({
  params,
}: {
  params: Promise<{ variantId: string }>;
}) {
  const actor = await requireActor();
  const { variantId } = await params;
  if (!UUID_RE.test(variantId)) notFound();

  if (!can(actor, "inventory:read")) {
    return (
      <main>
        <h1>Stock history</h1>
        <p className="error">Your role does not include access to inventory.</p>
      </main>
    );
  }

  const variant = await withTenant(actor.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        sku: productVariants.sku,
        productId: products.id,
        productTitle: products.title,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(eq(productVariants.id, variantId), isNull(productVariants.deletedAt)))
      .limit(1);
    return row ?? null;
  });

  // Another tenant's variant is invisible under RLS → plain 404.
  if (!variant) notFound();

  const movements = await getMovements(actor.tenantId, variantId, { limit: 200 });
  const total = movements.reduce((sum, m) => sum + m.delta, 0);

  return (
    <main>
      <nav className="crumbs">
        <Link href="/inventory">Inventory</Link> ·{" "}
        <Link href={`/products/${variant.productId}`}>{variant.productTitle}</Link>
      </nav>

      <h1>Stock history</h1>
      <p className="muted">
        <code>{variant.sku}</code> · {movements.length}{" "}
        {movements.length === 1 ? "movement" : "movements"} · sums to {total}
      </p>

      {movements.length === 0 ? (
        <div className="panel">
          <p className="muted">No movements yet.</p>
        </div>
      ) : (
        <div className="panel">
          <table className="grid">
            <thead>
              <tr>
                <th>When</th>
                <th style={{ textAlign: "right" }}>Change</th>
                <th>Reason</th>
                <th>Note</th>
                <th>Who</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m.id}>
                  <td>{m.createdAt.toLocaleString("en-IN")}</td>
                  <td style={{ textAlign: "right" }}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                  <td>
                    {REASON_LABELS[m.reason]}
                    {m.referenceType && <span className="muted"> · {m.referenceType}</span>}
                  </td>
                  <td>{m.note ?? <span className="muted">—</span>}</td>
                  <td>{m.createdByName ?? <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
