import { paiseToDecimalString } from "@platform/core/catalog";
import type { ProductDetail } from "@platform/core/catalog/server";

import { mediaUrl } from "./media";

/**
 * Structured data.
 *
 * Generated from catalog rows, never hand-authored per tenant
 * (blueprint §6.2). Two rules govern everything here:
 *
 *  1. Never state something the database does not know. Google penalises
 *     structured data that contradicts the page, and an invented
 *     `aggregateRating` is both a manual-action risk and a lie to a
 *     shopper. Reviews arrive in Phase 4; until then there is no rating
 *     property at all.
 *
 *  2. Prices are bare decimal strings. A `price` carrying a ₹ or a
 *     thousands separator is silently dropped — the rich result just
 *     stops appearing, with nothing in Search Console to explain it.
 */

export type JsonLd = Record<string, unknown>;

/** Drops keys whose value is null/undefined so no empty properties ship. */
function compact(obj: JsonLd): JsonLd {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
}

export function organizationJsonLd(input: {
  name: string;
  url: string;
  logoUrl?: string | null;
}): JsonLd {
  return compact({
    "@context": "https://schema.org",
    "@type": "Organization",
    name: input.name,
    url: input.url,
    logo: input.logoUrl ?? undefined,
  });
}

export function websiteJsonLd(input: { name: string; url: string }): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: input.name,
    url: input.url,
    // Declares the site search endpoint. Only claimed because /search
    // genuinely exists and accepts ?q= — claiming it otherwise produces
    // a sitelinks searchbox that 404s.
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${input.url}/search?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

export function breadcrumbJsonLd(trail: { name: string; url: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * Product structured data.
 *
 * A product with several prices emits an AggregateOffer rather than a
 * pile of Offers: Google shows a range, and the alternative — one Offer
 * per variant, each at the same URL — reads as duplicate offers for one
 * page.
 *
 * `availability` reflects only what the catalog currently models:
 * whether the merchant has the variant switched on. Stock levels arrive
 * with the inventory ledger in Phase 2, and this becomes a real signal
 * then. Claiming OutOfStock we cannot substantiate would suppress the
 * listing; claiming InStock for a disabled variant would mislead.
 */
export function productJsonLd(input: {
  product: ProductDetail;
  url: string;
  organizationName: string;
  imageUrls: string[];
}): JsonLd {
  const { product, url } = input;

  const sellable = product.variants.filter((v) => v.isActive);
  const prices = sellable.map((v) => v.pricePaise);
  const currency = sellable[0]?.currency ?? "INR";
  const availability =
    sellable.length > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";

  const low = prices.length ? Math.min(...prices) : null;
  const high = prices.length ? Math.max(...prices) : null;

  const offers =
    low === null || high === null
      ? undefined
      : low === high
        ? compact({
            "@type": "Offer",
            url,
            price: paiseToDecimalString(low),
            priceCurrency: currency,
            availability,
            itemCondition: "https://schema.org/NewCondition",
          })
        : compact({
            "@type": "AggregateOffer",
            url,
            lowPrice: paiseToDecimalString(low),
            highPrice: paiseToDecimalString(high),
            priceCurrency: currency,
            offerCount: sellable.length,
            availability,
          });

  return compact({
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    // Strip the merchant's HTML: schema.org descriptions are plain text,
    // and markup here is either ignored or flagged.
    description: plainText(product.summary ?? product.description ?? "") || undefined,
    image: input.imageUrls.length > 0 ? input.imageUrls : undefined,
    // Only meaningful for a single-variant product; a shared SKU across
    // variants would be wrong.
    sku: sellable.length === 1 ? sellable[0]?.sku : undefined,
    brand: { "@type": "Brand", name: input.organizationName },
    offers,
  });
}

export function itemListJsonLd(items: { name: string; url: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      url: item.url,
    })),
  };
}

/**
 * Collapses merchant HTML to plain text.
 *
 * Deliberately blunt — this output only ever lands in a JSON string or a
 * meta tag, never in the DOM, so it does not need to be a sanitiser. It
 * needs to not carry tags into a field that must be text.
 */
export function plainText(html: string, maxLength = 5000): string {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Meta descriptions are truncated by search engines around 160 chars. */
export function metaDescription(...candidates: (string | null | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = plainText(candidate, 160);
    if (text.length > 0) return text;
  }
  return undefined;
}

/** Merchant SEO overrides, read defensively out of the `seo` jsonb. */
export type SeoOverrides = {
  title?: string;
  description?: string;
  noindex?: boolean;
};

export function readSeoOverrides(seo: unknown): SeoOverrides {
  if (typeof seo !== "object" || seo === null) return {};
  const raw = seo as Record<string, unknown>;

  return {
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : undefined,
    description:
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim()
        : undefined,
    noindex: raw.noindex === true,
  };
}

/**
 * Absolute image URLs for structured data.
 *
 * schema.org `image` must be absolute. `mediaUrl` may return a
 * site-relative path when MEDIA_PUBLIC_BASE_URL is unset (local
 * development), and a relative URL in JSON-LD is silently ignored —
 * costing the rich result with nothing to show for it in Search Console.
 */
export function imageUrlsFor(images: { storageKey: string }[], origin: string): string[] {
  return images.map((i) => {
    const url = mediaUrl(i.storageKey);
    return url.startsWith("http://") || url.startsWith("https://") ? url : `${origin}${url}`;
  });
}
