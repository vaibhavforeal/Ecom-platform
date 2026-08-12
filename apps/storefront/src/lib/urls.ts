import { headers } from "next/headers";
import { cache } from "react";

import { primaryHostname } from "@platform/core";

/**
 * Absolute URLs.
 *
 * Every absolute URL is derived from the resolved tenant, never from an
 * env var — the storefront serves arbitrary tenant hostnames and must
 * never assume its own origin.
 */

/**
 * The origin every canonical URL, sitemap entry and JSON-LD `url` is
 * built on.
 *
 * Uses the tenant's PRIMARY hostname rather than the Host header that
 * happened to arrive. A store reachable at both an apex and a www serves
 * identical content at each, and letting the canonical follow the
 * request would declare both canonical — which declares neither, and
 * splits the ranking between them.
 *
 * The one exception is the port. `domains.hostname` stores no port, so
 * in development the primary hostname is `acme.localhost` while the
 * request is to `acme.localhost:3000`; emitting the former would produce
 * canonicals and sitemap links that do not resolve. When the request
 * host matches the primary hostname apart from its port, the request
 * host is kept verbatim.
 */
export const getOrigin = cache(async (tenantId: string): Promise<string> => {
  const h = await headers();
  const requestHost = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const requestHostname = requestHost.split(":")[0]?.toLowerCase() ?? "";

  const primary = await primaryHostname(tenantId);
  const host = primary && primary !== requestHostname ? primary : requestHost || primary || "";

  return `${protocolFor(h.get("x-forwarded-proto"), host)}://${host}`;
});

/**
 * Canonical URLs are https everywhere except local development.
 *
 * `x-forwarded-proto` is trusted when Caddy sets it. Without it, the
 * only hosts assumed insecure are loopback ones — defaulting to http
 * would emit http canonicals in production, which either redirect or
 * are treated as a separate, competing URL.
 */
function protocolFor(forwarded: string | null, host: string): "http" | "https" {
  if (forwarded === "http" || forwarded === "https") return forwarded;

  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  const isLocal =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";

  return isLocal ? "http" : "https";
}

/**
 * Public paths.
 *
 * Flat, one segment: `url_slugs` is keyed per tenant across products,
 * categories and collections precisely so a slug can never mean two
 * things, which is what makes this shape safe. Shorter URLs also survive
 * being pasted into WhatsApp, which is how most Indian storefront links
 * actually travel.
 */
export const paths = {
  home: () => "/",
  entity: (slug: string) => `/${encodeURIComponent(slug)}`,
  search: (q?: string) => (q ? `/search?q=${encodeURIComponent(q)}` : "/search"),
};

export async function absoluteUrl(tenantId: string, path: string): Promise<string> {
  return `${await getOrigin(tenantId)}${path}`;
}
