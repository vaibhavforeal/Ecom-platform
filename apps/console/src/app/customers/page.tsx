import Link from "next/link";

import { can } from "@platform/core";
import { listCustomers } from "@platform/core/customers/server";

import { requireActor } from "../../lib/session";

export const dynamic = "force-dynamic";

/**
 * Read-only customers list (design D14): name, phone, first order date
 * and an order count computed by aggregate query — deliberately no
 * projection columns to drift. Customers appear here by checking out;
 * there is no create/edit surface in Phase 2.
 */

const PAGE_SIZE = 50;

type Search = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" });

export default async function CustomersPage({ searchParams }: Search) {
  const actor = await requireActor();

  if (!can(actor, "customers:read")) {
    return (
      <main>
        <h1>Customers</h1>
        <p className="error">Your role does not include access to customers.</p>
      </main>
    );
  }

  const params = await searchParams;
  const q = first(params.q)?.trim() || undefined;
  const page = Math.max(Number.parseInt(first(params.page) ?? "1", 10) || 1, 1);

  const { items, total } = await listCustomers(actor.tenantId, {
    q,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const queryPrefix = q ? `q=${encodeURIComponent(q)}&` : "";

  return (
    <main>
      <nav className="crumbs">
        <Link href="/">Dashboard</Link>
      </nav>

      <h1>Customers</h1>
      <p className="muted">
        {total} {total === 1 ? "customer" : "customers"}
        {q ? ` matching “${q}”` : ""}
      </p>

      <div className="panel">
        <form action="/customers" method="get" role="search">
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search name, phone or email"
            aria-label="Search customers"
          />{" "}
          <button type="submit" className="chip">
            Search
          </button>
        </form>
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <p className="muted">
            {q
              ? "No customers match that search."
              : "No customers yet. A customer appears here after their first checkout."}
          </p>
        </div>
      ) : (
        <div className="panel">
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Email</th>
                <th>First order</th>
                <th style={{ textAlign: "right" }}>Orders</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td>{row.name ?? <span className="muted">—</span>}</td>
                  <td>
                    <code>{row.phoneE164}</code>
                  </td>
                  <td>{row.email ?? <span className="muted">—</span>}</td>
                  <td>
                    {row.firstOrderAt ? (
                      dateFormat.format(row.firstOrderAt)
                    ) : (
                      <span className="muted">no order yet</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>{row.orderCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="pagination" aria-label="Pagination">
          {page > 1 && (
            <Link href={`/customers?${queryPrefix}page=${page - 1}`} rel="prev">
              ← Previous
            </Link>
          )}
          <span className="muted">
            Page {page} of {pages}
          </span>
          {page < pages && (
            <Link href={`/customers?${queryPrefix}page=${page + 1}`} rel="next">
              Next →
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
