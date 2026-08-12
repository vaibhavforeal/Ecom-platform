import { getCachedSitemapEntries } from "../../lib/catalog";
import {
  URLS_PER_SITEMAP,
  renderSitemapIndex,
  renderUrlSet,
  sitemapChunkPath,
  xmlResponse,
} from "../../lib/sitemap";
import { getOrigin, paths } from "../../lib/urls";
import { getTenant } from "../../lib/tenant";

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
 * Per-host sitemap.
 *
 * Written by hand rather than through Next's `sitemap.ts` convention,
 * because that convention produces one sitemap per DEPLOYMENT. This
 * storefront serves every tenant from a single deployment, so the
 * sitemap has to be resolved from the Host header on each request —
 * otherwise every merchant is handed the same list of URLs, which is
 * both a cross-tenant leak and useless to all of them.
 *
 * Small stores get a plain urlset; large ones get an index pointing at
 * chunks, per blueprint §6.2.
 */
export async function GET(): Promise<Response> {
  const tenant = await getTenant();

  // No default tenant, ever. An unknown host gets nothing, not the
  // first store in the database.
  if (!tenant || tenant.status === "suspended" || tenant.status === "churned") {
    return new Response("Not found", { status: 404 });
  }

  const origin = await getOrigin(tenant.tenantId);
  const entries = await getCachedSitemapEntries(tenant.tenantId);

  if (entries.length + 1 > URLS_PER_SITEMAP) {
    const chunks = Math.ceil(entries.length / URLS_PER_SITEMAP);
    return xmlResponse(
      renderSitemapIndex(
        Array.from({ length: chunks }, (_, i) => ({
          loc: `${origin}${sitemapChunkPath(i + 1)}`,
          // The newest change in each chunk, so a crawler can skip
          // chunks it has already seen.
          lastmod: entries[i * URLS_PER_SITEMAP]?.updatedAt ?? null,
        })),
      ),
    );
  }

  return xmlResponse(
    renderUrlSet([
      { loc: `${origin}/`, lastmod: null },
      ...entries.map((e) => ({
        loc: `${origin}${paths.entity(e.slug)}`,
        lastmod: e.updatedAt,
      })),
    ]),
  );
}
