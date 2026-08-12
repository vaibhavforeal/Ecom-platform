import type { SearchIndexing, TenantStatus } from "@platform/db";

/**
 * Should this tenant's storefront be indexed by search engines?
 *
 * Precedence rules (in order):
 * 1. Suspended or churned tenants are NEVER indexed, regardless of the
 *    searchIndexing setting. This is a platform safety decision: a
 *    suspended store must not remain in the index because someone set
 *    "indexed" before suspension.
 * 2. searchIndexing === "indexed" → true
 * 3. searchIndexing === "noindex" → false
 * 4. searchIndexing === "auto" → status === "active"
 *
 * Returns the boolean to be used for both robots.txt (Allow vs Disallow)
 * and page-level robots meta tags.
 */
export function isSearchIndexable(tenant: {
  status: TenantStatus;
  searchIndexing: SearchIndexing;
}): boolean {
  // Platform override: suspended and churned stores are never indexed
  if (tenant.status === "suspended" || tenant.status === "churned") {
    return false;
  }

  // Explicit merchant choice takes precedence
  if (tenant.searchIndexing === "indexed") {
    return true;
  }

  if (tenant.searchIndexing === "noindex") {
    return false;
  }

  // Auto mode: index only active tenants
  return tenant.status === "active";
}
