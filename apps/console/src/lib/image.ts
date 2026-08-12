import sharp from "sharp";

import { isAnimatedPng } from "@platform/core/media";
import type { AllowedImageMimeType } from "@platform/core/media";

/**
 * Metadata stripping at the upload boundary.
 *
 * The worker strips its derivatives, but the ORIGINAL is what the
 * storefront actually links: `ProductGrid` renders `mediaUrl(storageKey)`
 * with no `srcSet`, the PDP hero uses it as the `src`, and `seo.ts` puts
 * its absolute URL into JSON-LD `image` — i.e. into Google. Storing the
 * raw upload therefore publishes whatever the merchant's phone attached,
 * including the GPS coordinates of where the photo was taken, on a
 * publicly cacheable URL. Stripping only on the way out is not stripping.
 *
 * Order matters and is easy to get backwards:
 *
 *  1. `.rotate()` BAKES the EXIF Orientation into the pixels. It has to
 *     happen before the tag is dropped — strip first and the tag is gone
 *     while the pixels are still sideways, so the worker's own
 *     `.rotate()` becomes a no-op and every portrait photo ships rotated
 *     a quarter turn. A privacy fix traded for a correctness bug.
 *  2. sharp writes no EXIF/XMP/IPTC unless asked to keep it, so the
 *     re-encode below is the strip. Do not add .keepMetadata().
 *
 * The output keeps the input's format, so the sniffed MIME type and the
 * storage key's extension stay true. Quality is high: this is the
 * merchant's master copy, not a derivative, and it is what the PDP hero
 * currently serves.
 */

/**
 * Pixel ceiling for the REQUEST path — deliberately lower than the
 * worker's `MAX_IMAGE_PIXELS`, and not an oversight.
 *
 * The worker decodes at `concurrency: 2` in a process of its own. This
 * runs inside the Next server with no concurrency bound at all, so the
 * per-request ceiling is most of what stands between a handful of
 * simultaneous uploads and the console's memory. At 4 bytes a pixel this
 * is ~120 MB of raw buffer per in-flight decode; the worker's 50 M would
 * be ~200 MB.
 *
 * It costs little that is real: the 10 MB byte cap already excludes any
 * photograph much above this size (a 30 MP JPEG is well past 10 MB), so
 * what this rejects is the pathological case — a flat, highly
 * compressible canvas whose byte count says nothing about its cost.
 */
export const MAX_UPLOAD_PIXELS = 30_000_000;

export type SanitizedOriginal =
  | { ok: true; bytes: Buffer }
  | { ok: false; code: "animated_image_unsupported" | "image_too_large"; message: string };

const ANIMATION_REJECTION = {
  ok: false,
  code: "animated_image_unsupported",
  message: "Animated images are not supported. Upload a single-frame image.",
} as const;

export async function sanitizeOriginal(
  bytes: Uint8Array,
  mimeType: AllowedImageMimeType,
): Promise<SanitizedOriginal> {
  /**
   * Animation is REFUSED, not flattened.
   *
   * The re-encode below decodes page one and writes a single static
   * frame, so an animated upload would return 201 with the merchant's
   * animation silently gone — and they would find out by looking at
   * their own storefront. Telling them is the lesser failure.
   *
   * Preserving animation is a bigger change than it looks: `.rotate()`
   * and the pixel ceiling both behave differently against the tall
   * "toilet roll" that `{ animated: true }` produces, and the derivative
   * ladder would still emit static output. Not worth smuggling in here.
   */
  if (isAnimatedPng(bytes)) return ANIMATION_REJECTION;

  // Probed WITHOUT the ceiling: reading a header allocates no pixels, and
  // doing it here means an oversized image gets a precise error instead
  // of libvips' generic decode failure.
  const metadata = await sharp(bytes, { limitInputPixels: false }).metadata();

  // Animated WebP and AVIF. An APNG reports no pages at all, which is
  // exactly why the byte check above exists.
  if ((metadata.pages ?? 1) > 1) return ANIMATION_REJECTION;

  const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
  if (pixels > MAX_UPLOAD_PIXELS) {
    return {
      ok: false,
      code: "image_too_large",
      message: `Images must be ${MAX_UPLOAD_PIXELS} pixels or fewer; this one is ${pixels}.`,
    };
  }

  // Belt and braces: the probe above is advisory, this is enforcement. A
  // header that lies about its dimensions still cannot get past here.
  const pipeline = sharp(bytes, { limitInputPixels: MAX_UPLOAD_PIXELS }).rotate();

  switch (mimeType) {
    case "image/jpeg":
      return { ok: true, bytes: await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer() };
    case "image/png":
      // Default compressionLevel (6), not 9. Level 9 on a large canvas is
      // tens of seconds on a libuv threadpool of four that is also
      // serving the storage driver's fs calls, for a few percent of size.
      return { ok: true, bytes: await pipeline.png().toBuffer() };
    case "image/webp":
      return { ok: true, bytes: await pipeline.webp({ quality: 92 }).toBuffer() };
    case "image/avif":
      // Low effort: this one runs inside the request, not the worker.
      return { ok: true, bytes: await pipeline.avif({ quality: 63, effort: 3 }).toBuffer() };
  }
}
