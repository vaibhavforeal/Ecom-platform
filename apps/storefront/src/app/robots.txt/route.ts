import { isSearchIndexable } from "@platform/core";

import { getOrigin } from "../../lib/urls";
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
 * Per-host robots.txt.
 *
 * Served per tenant, not per deployment. The `Sitemap:` line must point
 * at the requesting store's own sitemap — one shared robots.txt would
 * send every merchant's crawler to the same place.
 *
 * A store that is not live is disallowed wholesale. That covers the
 * staging hostname in the blueprint §6.3 migration checklist: a catalog
 * indexed on a staging domain competes with the same catalog on the real
 * one, and de-indexing it afterwards is slow and unreliable.
 */
export async function GET(): Promise<Response> {
  const tenant = await getTenant();

  const body =
    !tenant || !isSearchIndexable(tenant)
      ? ["User-agent: *", "Disallow: /"].join("\n")
      : [
          "User-agent: *",
          "Allow: /",
          // Internal search results are thin, near-duplicate pages
          // generated from a query parameter. Indexed, they compete with
          // the category pages that should rank.
          "Disallow: /search",
          "",
          `Sitemap: ${await getOrigin(tenant.tenantId)}/sitemap.xml`,
        ].join("\n");

  return new Response(`${body}\n`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
