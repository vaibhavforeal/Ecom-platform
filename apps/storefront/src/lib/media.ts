import type { MediaDerivative } from "@platform/core/media";

/**
 * Image URLs.
 *
 * Media rows store an object-storage KEY, never a URL. The public base
 * changes between local development, staging and production, and a URL
 * baked into a row at upload time is a row that breaks the day the CDN
 * hostname changes — with no way to fix it short of a data migration.
 *
 * The derivative pipeline that populates these keys is built alongside
 * the console; until it runs, a product simply has no images and the
 * storefront renders without them.
 */

/**
 * The ladder and the record shape are owned by `@platform/core/media` —
 * the same module the pipeline plans and writes from — and re-exported
 * here so existing importers are unaffected. One definition is the only
 * way `srcset` cannot drift from what was actually rendered.
 */
export { IMAGE_WIDTHS } from "@platform/core/media";
export type { MediaDerivative };

function publicBase(): string {
  // Trailing slash trimmed so callers can always join with a single one.
  return (process.env.MEDIA_PUBLIC_BASE_URL ?? "/media").replace(/\/+$/, "");
}

export function mediaUrl(storageKey: string): string {
  return `${publicBase()}/${storageKey.replace(/^\/+/, "")}`;
}

function isDerivative(value: unknown): value is MediaDerivative {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Partial<MediaDerivative>;
  return typeof d.storageKey === "string" && typeof d.width === "number";
}

/** Parses the `derivatives` jsonb, tolerating anything unexpected in it. */
export function parseDerivatives(value: unknown): MediaDerivative[] {
  return Array.isArray(value) ? value.filter(isDerivative) : [];
}

/**
 * A `srcset` for one format, or null if the pipeline produced none.
 *
 * Returning null rather than an empty string matters: an empty srcset
 * attribute makes some browsers fetch nothing at all.
 */
export function srcSetFor(derivatives: unknown, format: MediaDerivative["format"]): string | null {
  const matching = parseDerivatives(derivatives)
    .filter((d) => d.format === format)
    .sort((a, b) => a.width - b.width);

  if (matching.length === 0) return null;
  return matching.map((d) => `${mediaUrl(d.storageKey)} ${d.width}w`).join(", ");
}

/**
 * What to put in `sizes`.
 *
 * Wrong `sizes` is worse than none: the browser picks a candidate from
 * `srcset` BEFORE layout, using this hint alone, so an over-generous
 * value downloads a 1920px image to fill a 320px card and blows the LCP
 * budget that blueprint §6.2 sets at 2.5s on a mid-range Android.
 */
export const SIZES = {
  card: "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 300px",
  hero: "(max-width: 768px) 100vw, 640px",
} as const;
