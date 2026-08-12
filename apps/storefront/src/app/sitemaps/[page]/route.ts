import { getCachedSitemapEntries } from "../../../lib/catalog";
import { URLS_PER_SITEMAP, renderUrlSet, xmlResponse } from "../../../lib/sitemap";
import { getOrigin, paths } from "../../../lib/urls";
import { getTenant } from "../../../lib/tenant";

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
 * One chunk of a large store's sitemap, referenced from the index at
 * /sitemap.xml.
 *
 * The path is `/sitemaps/1` rather than `/sitemap-1.xml` because Next
 * dynamic segments have to be a whole path segment. A sitemap index may
 * point at any URL, so the extension is not required — only the
 * content type is, and it is set in xmlResponse.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ page: string }> },
): Promise<Response> {
  const tenant = await getTenant();
  if (!tenant || tenant.status === "suspended" || tenant.status === "churned") {
    return new Response("Not found", { status: 404 });
  }

  const { page } = await params;
  const index = Number.parseInt(page, 10);
  if (!Number.isInteger(index) || index < 1) {
    return new Response("Not found", { status: 404 });
  }

  const entries = await getCachedSitemapEntries(tenant.tenantId);
  const slice = entries.slice((index - 1) * URLS_PER_SITEMAP, index * URLS_PER_SITEMAP);

  // A chunk past the end is a stale index, not an empty store. 404 so a
  // crawler drops it rather than recording an empty sitemap as valid.
  if (slice.length === 0) return new Response("Not found", { status: 404 });

  const origin = await getOrigin(tenant.tenantId);

  return xmlResponse(
    renderUrlSet(
      slice.map((e) => ({ loc: `${origin}${paths.entity(e.slug)}`, lastmod: e.updatedAt })),
    ),
  );
}
