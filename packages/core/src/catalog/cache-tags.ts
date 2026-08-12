/**
 * Cache tags for the storefront's catalog reads. PURE — client-safe.
 *
 * The storefront wraps every catalog read in `unstable_cache` and tags
 * the entry with these (`apps/storefront/src/lib/catalog.ts`). The
 * console names the same strings when it asks the storefront to drop
 * what it cached. They live HERE, in the barrel both apps can import,
 * for one reason: a purge tag that does not match a cache tag purges
 * NOTHING, and it does it silently — no error, no log, no failing test,
 * nothing to see until a merchant reports that their edit never
 * appeared. Two copies of this scheme in two apps is one typo away from
 * that; one copy cannot drift from itself.
 */

/**
 * Tenant-prefixed, so one merchant's purge cannot clear another's.
 *
 * The prefix is not decoration: `tenantTagPrefix` is what the purge
 * endpoint checks every requested tag against, and it is the only thing
 * standing between "the console can purge a tenant's cache" and "anyone
 * holding the internal secret can purge the whole platform's".
 */
export const catalogTags = {
  all: (tenantId: string) => `t:${tenantId}:catalog`,
  product: (tenantId: string, productId: string) => `t:${tenantId}:product:${productId}`,
  slugs: (tenantId: string) => `t:${tenantId}:slugs`,
  categories: (tenantId: string) => `t:${tenantId}:categories`,
};

/** The prefix every one of a tenant's tags begins with. */
export function tenantTagPrefix(tenantId: string): string {
  return `t:${tenantId}:`;
}

/**
 * The tags a catalog write invalidates, for one tenant.
 *
 * WHY THIS SET IS COMPLETE
 *
 * Every entry the storefront caches carries `catalogTags.all`, so that
 * tag alone would empty the tenant's catalog cache. It is in the list
 * first and it is what actually does the work — in particular it is the
 * ONLY tag on product listings and on a collection's page, neither of
 * which has one of its own.
 *
 * The three narrower tags are sent as well because they are the ones
 * that NAME what changed:
 *
 *  - `slugs` covers slug resolution, and it is how a rename's old URL
 *    gets fixed. `getCachedSlugResolution` keys per slug but tags every
 *    entry with this single tenant-wide tag, so purging it drops the old
 *    slug's cached "render this product" answer AND the new slug's
 *    cached "404" — which is the redirect half of the bug.
 *  - `categories` covers the navigation the storefront renders on every
 *    page, which a taxonomy rename or a membership change alters.
 *  - `product:<id>` covers the PDP for each product the write touched.
 *
 * They are redundant TODAY, and that is stated rather than glossed: the
 * value is that a later cached read tagged only `product:<id>` — an
 * obvious thing to add — is already covered, instead of being a silent
 * hole nobody notices. The cost is three strings in an array.
 */
export function catalogPurgeTags(
  tenantId: string,
  productIds: readonly string[] = [],
): string[] {
  return [
    catalogTags.all(tenantId),
    catalogTags.slugs(tenantId),
    catalogTags.categories(tenantId),
    ...productIds.map((productId) => catalogTags.product(tenantId, productId)),
  ];
}
