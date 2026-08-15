import Link from "next/link";

import { can } from "@platform/core";
import { isLowStock } from "@platform/core/inventory";
import { listInventory } from "@platform/core/inventory/server";

import { requireActor } from "../../lib/session";
import { AdjustStock } from "./AdjustStock";

export const dynamic = "force-dynamic";

/**
 * The daily screen: every tracked variant and its level. Untracked
 * variants are deliberately absent — tracking is opt-in and this page is
 * the list of what opted in.
 */

const PAGE_SIZE = 50;

type Search = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function InventoryPage({ searchParams }: Search) {
  const actor = await requireActor();

  if (!can(actor, "inventory:read")) {
    return (
      <main>
        <h1>Inventory</h1>
        <p className="error">Your role does not include access to inventory.</p>
      </main>
    );
  }

  const params = await searchParams;
  const lowOnly = first(params.low) === "1";
  const page = Math.max(Number.parseInt(first(params.page) ?? "1", 10) || 1, 1);

  const { items, total } = await listInventory(actor.tenantId, {
    lowStockOnly: lowOnly,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const writable = can(actor, "inventory:write");

  return (
    <main>
      <nav className="crumbs">
        <Link href="/">Dashboard</Link> · <Link href="/products">Products</Link>
      </nav>

      <h1>Inventory</h1>
      <p className="muted">
        {total} tracked {total === 1 ? "variant" : "variants"}
        {lowOnly ? " · low stock" : ""}
      </p>

      <div className="panel">
        <nav className="toolbar">
          <Link href="/inventory" className="chip" aria-current={!lowOnly ? "page" : undefined}>
            All
          </Link>
          <Link href="/inventory?low=1" className="chip" aria-current={lowOnly ? "page" : undefined}>
            Low stock
          </Link>
        </nav>
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <p className="muted">
            {lowOnly
              ? "Nothing is low on stock."
              : "No tracked variants yet. Turn on tracking from a product's variants table."}
          </p>
        </div>
      ) : (
        <div className="panel">
          <table className="grid">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th style={{ textAlign: "right" }}>On hand</th>
                <th style={{ textAlign: "right" }}>Reserved</th>
                <th style={{ textAlign: "right" }}>Available</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.variantId}>
                  <td>
                    <Link href={`/products/${row.productId}`}>{row.productTitle}</Link>
                    {Object.keys(row.options).length > 0 && (
                      <div className="muted">
                        {Object.entries(row.options)
                          .map(([axis, value]) => `${axis}: ${value}`)
                          .join(" · ")}
                      </div>
                    )}
                    {!row.isActive && <div className="muted">not for sale</div>}
                  </td>
                  <td>
                    <code>{row.sku}</code>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {row.onHand}
                    {isLowStock(row.onHand, row.lowStockAt) && (
                      <>
                        {" "}
                        <span className="badge badge-draft">low</span>
                      </>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }} className="muted">
                    {row.reserved === 0 ? "—" : row.reserved}
                  </td>
                  <td style={{ textAlign: "right" }}>{row.available}</td>
                  <td style={{ textAlign: "right" }}>
                    <AdjustStock
                      variantId={row.variantId}
                      sku={row.sku}
                      onHand={row.onHand}
                      canWrite={writable}
                    />{" "}
                    <Link href={`/inventory/${row.variantId}`} className="chip">
                      History
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="pagination" aria-label="Pagination">
          {page > 1 && (
            <Link href={`/inventory?${lowOnly ? "low=1&" : ""}page=${page - 1}`} rel="prev">
              ← Previous
            </Link>
          )}
          <span className="muted">
            Page {page} of {pages}
          </span>
          {page < pages && (
            <Link href={`/inventory?${lowOnly ? "low=1&" : ""}page=${page + 1}`} rel="next">
              Next →
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
