import { headers } from "next/headers";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";

import { resolveTenantByHost } from "@platform/core";
import type { ResolvedTenant } from "@platform/core";

/**
 * Tenant resolution for the storefront.
 *
 * Implemented as a request-scoped server function rather than Next.js
 * middleware. Middleware runs on the edge runtime where a Postgres
 * driver cannot, so a middleware implementation would need a second
 * network hop to resolve every request. Doing it here — memoised per
 * request by React's `cache` — is simpler, and works on any Next
 * version without runtime flags.
 *
 * See PLATFORM_BLUEPRINT.md §2.3.
 */

export const getTenant = cache(async (): Promise<ResolvedTenant | null> => {
  let host: string | null;

  try {
    const h = await headers();
    // x-forwarded-host is set by Caddy; `host` is the direct-connection
    // fallback used in local development.
    host = h.get("x-forwarded-host") ?? h.get("host");
  } catch {
    // No request to read. Next prerenders the built-in /404 at build
    // time, and the root layout's generateMetadata runs during it — so
    // `headers()` throws and, without this, the build dies inside Next's
    // fallback error page ("<Html> should not be imported outside of
    // pages/_document"), which says nothing about the real cause.
    //
    // No request means no hostname means no tenant, which is exactly
    // what a 404 should render. Swallowing this cannot turn a real page
    // static by accident: every route that reads a request is explicitly
    // `force-dynamic`.
    return null;
  }

  return resolveTenantByHost(host);
});

/**
 * Resolve or refuse. Every storefront page and route handler starts here.
 *
 * There is no default tenant, and adding one would be the single most
 * damaging change anyone could make to this codebase: a misconfigured
 * hostname would silently serve one merchant's catalog, prices and
 * customers under another merchant's domain. Unknown host → 404.
 */
export async function requireTenant(): Promise<ResolvedTenant> {
  const tenant = await getTenant();
  if (!tenant) notFound();

  // Apex → www (or vice versa) canonicalisation. Duplicate hostnames
  // serving identical content split ranking signals, so we 301 rather
  // than serve both.
  if (tenant.redirectTo) {
    const h = await headers();
    permanentRedirect(`https://${tenant.redirectTo}${h.get("x-original-uri") ?? "/"}`);
  }

  // A lapsed subscription should not look like a deleted business to
  // the merchant's customers.
  if (tenant.status === "suspended" || tenant.status === "churned") {
    notFound();
  }

  return tenant;
}
