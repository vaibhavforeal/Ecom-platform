import type { Metadata } from "next";

import { normalizeSearchQuery } from "@platform/core/catalog/server";

import { ProductGrid } from "../../components/ProductGrid";
import { getCachedProducts } from "../../lib/catalog";
import { requireTenant } from "../../lib/tenant";

/**
 * Rendered per request, never statically.
 *
 * Next's full-route cache is keyed by PATHNAME and does not include the
 * Host header, so a statically generated /white-shirt would be served to
 * every tenant that has one. Edge caching is Cloudflare's job (it keys on
 * host + path); this app resolves the tenant on every request.
 */
export const dynamic = "force-dynamic";


/**
 * Search results.
 *
 * `noindex, follow`: an internal search results page is thin,
 * near-duplicate content generated from a URL parameter, and letting
 * crawlers index it produces thousands of low-value pages competing with
 * the category pages that should rank. `follow` keeps the links on it
 * useful for discovery.
 */
export const metadata: Metadata = {
  title: "Search",
  robots: { index: false, follow: true },
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tenant = await requireTenant();
  const params = await searchParams;

  const raw = Array.isArray(params.q) ? params.q[0] : params.q;
  const query = normalizeSearchQuery(raw);

  // An empty ?q= is not a search for nothing — it is no search at all.
  // Running it would render "0 results for ''".
  const results = query ? await getCachedProducts(tenant.tenantId, { search: query, limit: 48 }) : null;

  return (
    <main>
      <h1>Search</h1>

      <form action="/search" method="get" role="search">
        <input
          type="search"
          name="q"
          defaultValue={query ?? ""}
          placeholder="Search products"
          aria-label="Search products"
        />
        <button type="submit">Search</button>
      </form>

      {results && (
        <>
          <p className="muted">
            {results.total === 0
              ? `No results for “${query}”.`
              : `${results.total} result${results.total === 1 ? "" : "s"} for “${query}”.`}
          </p>
          <ProductGrid products={results.items} />
        </>
      )}
    </main>
  );
}
