/**
 * Sitemap rendering.
 *
 * Shared between the index and its chunks so the two cannot disagree
 * about how many URLs fit in a file — a mismatch there produces an index
 * pointing at chunks that do not exist.
 */

/**
 * Google's limit is 50,000 URLs (or 50 MB) per file. Deliberately below
 * it: the cap is on the FILE, and a store whose slugs are long can hit
 * the byte limit first.
 */
export const URLS_PER_SITEMAP = 25_000;

export type SitemapUrl = { loc: string; lastmod: Date | null };

/**
 * Slugs are merchant-authored and may contain `&`, `<` or a quote.
 * Unescaped, the document is malformed and Google rejects the WHOLE
 * sitemap rather than skipping the one bad URL.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const NS = "http://www.sitemaps.org/schemas/sitemap/0.9";

export function renderUrlSet(urls: SitemapUrl[]): string {
  const body = urls
    .map(
      (u) =>
        `  <url><loc>${escapeXml(u.loc)}</loc>` +
        (u.lastmod ? `<lastmod>${u.lastmod.toISOString()}</lastmod>` : "") +
        `</url>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${NS}">\n${body}\n</urlset>`;
}

export function renderSitemapIndex(sitemaps: SitemapUrl[]): string {
  const body = sitemaps
    .map(
      (s) =>
        `  <sitemap><loc>${escapeXml(s.loc)}</loc>` +
        (s.lastmod ? `<lastmod>${s.lastmod.toISOString()}</lastmod>` : "") +
        `</sitemap>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="${NS}">\n${body}\n</sitemapindex>`;
}

export function xmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      // Cached at the CDN, which keys on host + path — so tenants cannot
      // collide there the way they would in Next's pathname-keyed
      // full-route cache.
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}

/** Chunk URL for page `n` (1-based). */
export function sitemapChunkPath(n: number): string {
  return `/sitemaps/${n}`;
}
