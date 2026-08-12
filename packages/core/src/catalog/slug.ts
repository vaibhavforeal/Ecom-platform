/**
 * Slugs — the part of the catalog that is permanent.
 *
 * A price can be corrected, a title rewritten, a photo replaced. A URL
 * that has been indexed, linked to and shared cannot: changing it throws
 * away whatever authority the page accumulated, and 404ing it throws
 * away the inbound links too. Everything here exists to make renaming
 * safe rather than to make slugs pretty.
 *
 * See PLATFORM_BLUEPRINT.md §6.2.
 */

/**
 * Long enough for a descriptive product title, short enough to stay
 * readable in a shared link. Truncation happens at a word boundary.
 */
export const MAX_SLUG_LENGTH = 96;

/**
 * Paths the storefront needs for itself.
 *
 * `url_slugs` is keyed per tenant across all entity types precisely so
 * flat `/{slug}` URLs stay possible without a migration. That option
 * only survives if these words are unavailable from the start —
 * reserving them later means breaking whichever merchant already took
 * one.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "cart",
  "checkout",
  "search",
  "account",
  "orders",
  "order",
  "login",
  "logout",
  "register",
  "api",
  "admin",
  "console",
  "sitemap",
  "sitemap.xml",
  "robots.txt",
  "favicon.ico",
  "_next",
  "static",
  "assets",
  "media",
  "products",
  "product",
  "categories",
  "category",
  "collections",
  "collection",
  "pages",
  "policies",
  "404",
  "500",
]);

/**
 * Converts a merchant-authored title into a URL slug.
 *
 * Latin diacritics are folded (Café → cafe) because merchants and
 * customers type the unaccented form. Non-Latin scripts are PRESERVED
 * rather than stripped: a Devanagari or Tamil title reduced to ASCII
 * yields an empty slug, and a store whose products are all
 * `/product-2`, `/product-3` is worse off than one with percent-encoded
 * but meaningful URLs. Google has handled non-ASCII paths for years.
 */
export function slugify(input: string, opts: { fallback?: string } = {}): string {
  const folded = input
    // NFKD splits Latin letters into base + combining accent; the range
    // below is the Latin combining block only, so Devanagari matras and
    // other scripts' marks survive intact.
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC");

  let slug = folded
    .toLowerCase()
    // Anything that is not a letter or a digit in ANY script becomes a
    // separator. Runs collapse to one hyphen.
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH);
    // Prefer cutting at a word boundary, but not if that leaves almost
    // nothing — a title whose first word is 90 characters keeps the cut.
    const lastHyphen = slug.lastIndexOf("-");
    if (lastHyphen >= MAX_SLUG_LENGTH / 2) slug = slug.slice(0, lastHyphen);
    slug = slug.replace(/-+$/, "");
  }

  return slug || opts.fallback || "item";
}

/**
 * Finds a free slug, appending `-2`, `-3`, … until one is available.
 *
 * `isTaken` is injected rather than querying here so this stays a pure
 * decision — the caller supplies a lookup already scoped to its tenant,
 * which is the only place that scoping can be got right.
 *
 * Numbering starts at 2 because `-1` reads as a duplicate of something,
 * while `shirt-2` reads as a second shirt.
 */
export async function availableSlug(
  desired: string,
  isTaken: (slug: string) => Promise<boolean>,
  opts: { maxAttempts?: number } = {},
): Promise<string> {
  const maxAttempts = opts.maxAttempts ?? 100;
  const base = RESERVED_SLUGS.has(desired) ? `${desired}-item` : desired;

  if (!(await isTaken(base))) return base;

  for (let n = 2; n <= maxAttempts; n++) {
    const candidate = `${truncateForSuffix(base, n)}-${n}`;
    if (!(await isTaken(candidate))) return candidate;
  }

  throw new Error(`Could not find a free slug for "${desired}" after ${maxAttempts} attempts`);
}

/** Keeps `base-27` within MAX_SLUG_LENGTH rather than silently overflowing. */
function truncateForSuffix(base: string, n: number): string {
  const room = MAX_SLUG_LENGTH - String(n).length - 1;
  return base.length <= room ? base : base.slice(0, room).replace(/-+$/, "");
}

export type SlugResolution =
  | { action: "render"; entityType: string; entityId: string }
  | { action: "redirect"; to: string; permanent: true }
  | { action: "notFound" };

export type SlugRow = {
  slug: string;
  entityType: string;
  entityId: string;
  isCanonical: boolean;
};

/**
 * Decides what a storefront request for `requested` should do.
 *
 * The redirect is PERMANENT, never temporary. A 302 tells search engines
 * to keep indexing the old URL and never transfers the ranking signal to
 * the new one, which defeats the entire point of keeping slug history.
 *
 * The exact status code is the transport's to choose, not this
 * function's — which is why this returns `permanent: true` rather than a
 * number. Next's `permanentRedirect()` emits 308 rather than 301;
 * Google documents the two as equivalent for consolidating signals, and
 * 308 additionally preserves the request method.
 *
 * `canonicalFor` is passed in — it is a second lookup, and making the
 * caller do it keeps this function decidable in a unit test.
 */
export function resolveSlug(
  requested: SlugRow | null,
  canonicalFor: (entityType: string, entityId: string) => string | null,
): SlugResolution {
  if (!requested) return { action: "notFound" };

  if (requested.isCanonical) {
    return {
      action: "render",
      entityType: requested.entityType,
      entityId: requested.entityId,
    };
  }

  const canonical = canonicalFor(requested.entityType, requested.entityId);

  // A historical slug whose entity has since lost its canonical row is
  // a deleted product. 404 is correct — redirecting to a guess would
  // send both users and crawlers somewhere arbitrary.
  if (!canonical) return { action: "notFound" };

  return { action: "redirect", to: canonical, permanent: true };
}
