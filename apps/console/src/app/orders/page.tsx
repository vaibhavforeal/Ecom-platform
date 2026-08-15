import Link from "next/link";

import { can } from "@platform/core";
import { formatPaise } from "@platform/core/catalog";
import { ORDER_STATUSES, formatOrderNumber } from "@platform/core/orders";
import type { OrderStatus } from "@platform/core/orders";
import { getOrderNumberPrefix, listOrders } from "@platform/core/orders/server";
import type { OrderListRow } from "@platform/core/orders/server";

import { requireActor } from "../../lib/session";

export const dynamic = "force-dynamic";

/**
 * The orders list. Server component — the query runs inside withTenant
 * on the server. Filter and paging are GET parameters (the products-page
 * pattern): a merchant who filters to "confirmed" and sends the URL to a
 * colleague should have that work.
 */

const PAGE_SIZE = 50;

type Search = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function label(status: string): string {
  return status.replaceAll("_", " ");
}

export default async function OrdersPage({ searchParams }: Search) {
  const actor = await requireActor();

  if (!can(actor, "orders:read")) {
    return (
      <main>
        <h1>Orders</h1>
        <p className="error">Your role does not include access to orders.</p>
      </main>
    );
  }

  const params = await searchParams;
  const search = first(params.q)?.slice(0, 120) ?? "";
  const rawStatus = first(params.status) ?? "all";
  const status = (ORDER_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as OrderStatus)
    : undefined;
  const page = Math.max(Number.parseInt(first(params.page) ?? "1", 10) || 1, 1);

  const [{ items, total }, prefix] = await Promise.all([
    listOrders(actor.tenantId, {
      status,
      q: search || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    getOrderNumberPrefix(actor.tenantId),
  ]);

  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  return (
    <main>
      <nav className="crumbs">
        <Link href="/">Dashboard</Link> · <Link href="/products">Products</Link> ·{" "}
        <Link href="/inventory">Inventory</Link>
      </nav>

      <h1>Orders</h1>
      <p className="muted">
        {total} {total === 1 ? "order" : "orders"}
        {status ? ` · ${label(status)}` : ""}
        {search ? ` · matching “${search}”` : ""}
      </p>

      <div className="panel">
        <form method="get" action="/orders" className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="q">Search by order number, buyer or phone</label>
            <input id="q" name="q" defaultValue={search} placeholder="ORD-1001, Asha, +91…" />
          </div>
          <div>
            <label htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={status ?? "all"}>
              <option value="all">All</option>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          </div>
          <button type="submit">Search</button>
        </form>
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <p className="muted">
            {search || status ? "Nothing matches that filter." : "No orders yet."}
          </p>
        </div>
      ) : (
        <div className="panel">
          <table className="grid">
            <thead>
              <tr>
                <th>Order</th>
                <th>Placed</th>
                <th>Buyer</th>
                <th>Status</th>
                <th>Payment</th>
                <th style={{ textAlign: "right" }}>Total</th>
                <th style={{ textAlign: "right" }}>COD due</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <OrderRow key={row.id} row={row} prefix={prefix} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="pagination" aria-label="Pagination">
          {page > 1 && (
            <Link href={pageHref(search, status, page - 1)} rel="prev">
              ← Previous
            </Link>
          )}
          <span className="muted">
            Page {page} of {pages}
          </span>
          {page < pages && (
            <Link href={pageHref(search, status, page + 1)} rel="next">
              Next →
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}

function pageHref(search: string, status: OrderStatus | undefined, page: number): string {
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (status) params.set("status", status);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/orders?${query}` : "/orders";
}

function OrderRow({ row, prefix }: { row: OrderListRow; prefix: string }) {
  return (
    <tr>
      <td>
        <Link href={`/orders/${row.id}`}>{formatOrderNumber(prefix, row.orderNumber)}</Link>
      </td>
      <td>{row.placedAt.toLocaleString("en-IN")}</td>
      <td>
        {row.buyerName}
        <div className="muted">{row.buyerPhoneE164}</div>
      </td>
      <td>
        <span className={`badge badge-${row.status}`}>{label(row.status)}</span>
      </td>
      <td>
        {label(row.paymentStatus)}
        <div className="muted">{label(row.paymentMode)}</div>
      </td>
      <td style={{ textAlign: "right" }}>
        {formatPaise(row.totalPaise, { currency: row.currency })}
      </td>
      <td style={{ textAlign: "right" }}>
        {row.codDuePaise === 0 ? (
          <span className="muted">—</span>
        ) : (
          formatPaise(row.codDuePaise, { currency: row.currency })
        )}
      </td>
    </tr>
  );
}
