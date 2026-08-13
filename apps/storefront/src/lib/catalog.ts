import { unstable_cache } from "next/cache";

import { catalogTags } from "@platform/core/catalog";
import {
  getCollectionById,
  getProductById,
  listCategories,
  listProducts,
  listSitemapEntries,
  resolveStorefrontSlug,
  sanitizeDescriptionHtml,
} from "@platform/core/catalog/server";
import type { ListOptions } from "@platform/core/catalog/server";

/**
 * Cached catalog reads.
 *
 * WHY THE DATA CACHE AND NOT FULL-ROUTE ISR
 *
 * Next's full-route cache is keyed by PATHNAME. It does not include the
 * Host header. On a multi-tenant storefront that is a data leak waiting
 * to happen: two merchants both have a product at `/white-shirt`, and
 * whichever renders first would be served to the other's customers,
 * under the other's domain. There is no configuration that adds the
 * host to that key.
 *
 * So the pages stay dynamically rendered — they read `headers()` to
 * resolve the tenant anyway, which forces dynamic rendering — and the
 * expensive part, the database work, is cached HERE with the tenant id
 * in the cache key. Edge caching is Cloudflare's job (blueprint §8.1),
 * and a CDN keys on host + path by default, so it is safe there.
 *
 * Every entry is tagged so a catalog change can purge precisely what it
 * touched rather than the whole store.
 *
 * `catalogTags` itself lives in `@platform/core/catalog` rather than
 * here. The console has to name these exact strings to purge them
 * (`POST /api/internal/revalidate`), and a purge tag that does not match
 * a cache tag purges nothing SILENTLY. One definition, imported by the
 * reader and the writer, cannot drift from itself.
 */

/**
 * Short by design.
 *
 * Tag purges are the primary invalidation path — `POST
 * /api/internal/revalidate`, called by the console after every committed
 * catalog write. This TTL is only the backstop for a purge that never
 * arrives: the storefront was unreachable, or a second replica never
 * heard about it. Long enough to absorb a traffic spike, short enough
 * that a merchant who edits a price does not file a support ticket.
 */
const TTL_SECONDS = 300;

export function getCachedSlugResolution(tenantId: string, slug: string) {
  return unstable_cache(
    () => resolveStorefrontSlug(tenantId, slug),
    ["slug", tenantId, slug],
    { tags: [catalogTags.all(tenantId), catalogTags.slugs(tenantId)], revalidate: TTL_SECONDS },
  )();
}

export function getCachedProduct(tenantId: string, productId: string) {
  return unstable_cache(
    async () => {
      const product = await getProductById(tenantId, productId);
      // Defence in depth, amortised: descriptions are sanitised on
      // write, but a row written past the write layer (psql, a restored
      // dump, a backfill) must still never reach
      // dangerouslySetInnerHTML. Sanitising here covers every render of
      // this cache entry for the price of one pass per fill. The
      // sanitiser is idempotent, so a correctly written row is
      // unchanged.
      if (product?.description) {
        return { ...product, description: sanitizeDescriptionHtml(product.description) || null };
      }
      return product;
    },
    ["product", tenantId, productId],
    {
      tags: [catalogTags.all(tenantId), catalogTags.product(tenantId, productId)],
      revalidate: TTL_SECONDS,
    },
  )();
}

export function getCachedCollection(tenantId: string, collectionId: string) {
  return unstable_cache(
    () => getCollectionById(tenantId, collectionId),
    ["collection", tenantId, collectionId],
    { tags: [catalogTags.all(tenantId)], revalidate: TTL_SECONDS },
  )();
}

export function getCachedCategories(tenantId: string) {
  return unstable_cache(() => listCategories(tenantId), ["categories", tenantId], {
    tags: [catalogTags.all(tenantId), catalogTags.categories(tenantId)],
    revalidate: TTL_SECONDS,
  })();
}

/**
 * Product listings.
 *
 * The options object is part of the cache key, so every distinct filter
 * and page gets its own entry. Search results are deliberately NOT
 * cached: the query space is unbounded, so caching it fills the store
 * with single-use entries and a trivial way to churn the cache.
 */
export function getCachedProducts(tenantId: string, opts: ListOptions = {}) {
  if (opts.search) return listProducts(tenantId, opts);

  return unstable_cache(
    () => listProducts(tenantId, opts),
    [
      "products",
      tenantId,
      (opts.categoryIds ?? []).join(","),
      opts.collectionId ?? "",
      String(opts.limit ?? ""),
      String(opts.offset ?? ""),
    ],
    { tags: [catalogTags.all(tenantId)], revalidate: TTL_SECONDS },
  )();
}

export function getCachedSitemapEntries(tenantId: string) {
  return unstable_cache(() => listSitemapEntries(tenantId), ["sitemap", tenantId], {
    tags: [catalogTags.all(tenantId), catalogTags.slugs(tenantId)],
    revalidate: TTL_SECONDS,
  })();
}
