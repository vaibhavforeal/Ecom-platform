import Link from "next/link";

import { can } from "@platform/core";
import { formatPaise } from "@platform/core/catalog";
import { CONSOLE_PAGE_SIZE, listProductsForConsole } from "@platform/core/catalog/server";
import type { ConsoleProductRow } from "@platform/core/catalog/server";

import { requireActor } from "../../lib/session";

export const dynamic = "force-dynamic";

/**
 * The product list.
 *
 * A server component, so the query runs inside `withTenant` on the
 * server and the merchant's catalog never travels to the browser as a
 * prop it did not ask for. Search and paging are GET parameters rather
 * than client state: a merchant who filters to "draft" and sends the URL
 * to a colleague should have that work.
 */

type Search = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
] as const;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProductsPage({ searchParams }: Search) {
  const actor = await requireActor();

  if (!can(actor, "catalog:read")) {
    return (
      <main>
        <h1>Products</h1>
        <p className="error">Your role does not include access to the catalog.</p>
      </main>
    );
  }

  const params = await searchParams;
  const search = first(params.q)?.slice(0, 120) ?? "";
  const rawStatus = first(params.status) ?? "all";
  const status = STATUS_FILTERS.some((f) => f.value === rawStatus)
    ? (rawStatus as (typeof STATUS_FILTERS)[number]["value"])
    : "all";

  const page = Math.max(Number.parseInt(first(params.page) ?? "1", 10) || 1, 1);

  const { items, total } = await listProductsForConsole(actor.tenantId, {
    search,
    status,
    limit: CONSOLE_PAGE_SIZE,
    offset: (page - 1) * CONSOLE_PAGE_SIZE,
  });

  const pages = Math.max(Math.ceil(total / CONSOLE_PAGE_SIZE), 1);
  const writable = can(actor, "catalog:write");

  return (
    <main>
      <nav className="crumbs">
        <Link href="/">Dashboard</Link> · <Link href="/products/taxonomy">Categories</Link>
      </nav>

      <h1>Products</h1>
      <p className="muted">
        {total} {total === 1 ? "product" : "products"}
        {status === "all" ? "" : ` · ${status}`}
        {search ? ` · matching “${search}”` : ""}
      </p>

      <div className="panel">
        <form method="get" action="/products" className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="q">Search by title or SKU</label>
            <input id="q" name="q" defaultValue={search} placeholder="Cotton shirt, ACME-SHIRT-M" />
          </div>
          <div>
            <label htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={status}>
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit">Search</button>
        </form>

        {writable && (
          <p style={{ marginTop: 16 }}>
            <Link href="/products/new" className="chip">
              New product
            </Link>
          </p>
        )}
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <p className="muted">
            {search || status !== "all"
              ? "Nothing matches that filter."
              : "No products yet. Create the first one."}
          </p>
        </div>
      ) : (
        <div className="panel">
          <table className="grid">
            <thead>
              <tr>
                <th>Product</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Price</th>
                <th style={{ textAlign: "right" }}>Variants</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <ProductRow key={row.id} row={row} />
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

function pageHref(search: string, status: string, page: number): string {
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (status !== "all") params.set("status", status);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/products?${query}` : "/products";
}

function ProductRow({ row }: { row: ConsoleProductRow }) {
  return (
    <tr>
      <td>
        <Link href={`/products/${row.id}`}>{row.title}</Link>
        <div className="muted">
          {row.slug ? <code>/{row.slug}</code> : <em>no URL — this product cannot be linked</em>}
          {/* Honest about the pipeline: an image the worker has not
              finished is not a picture the storefront will render. */}
          {row.image && row.image.status !== "ready" && (
            <> · image {row.image.status}</>
          )}
        </div>
      </td>
      <td>
        <span className={`badge badge-${row.status}`}>{row.status}</span>
      </td>
      <td style={{ textAlign: "right" }}>
        {row.minPricePaise === null ? (
          <span className="muted">—</span>
        ) : row.minPricePaise === row.maxPricePaise ? (
          formatPaise(row.minPricePaise, { currency: row.currency })
        ) : (
          `${formatPaise(row.minPricePaise, { currency: row.currency })} – ${formatPaise(
            row.maxPricePaise ?? row.minPricePaise,
            { currency: row.currency },
          )}`
        )}
      </td>
      <td style={{ textAlign: "right" }}>{row.variantCount}</td>
    </tr>
  );
}
