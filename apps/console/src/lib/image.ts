import sharp from "sharp";

import { MAX_IMAGE_PIXELS } from "@platform/core/media";
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
 * storage key's extension stay true. Quality is set high: this is the
 * merchant's master copy, not a derivative, and it is what the PDP hero
 * currently serves.
 *
 * This is CPU in a request handler, which the blueprint otherwise pushes
 * to the worker. One decode plus one encode is the price of not having a
 * window in which the un-stripped bytes are publicly readable.
 */
export async function sanitizeOriginal(
  bytes: Uint8Array,
  mimeType: AllowedImageMimeType,
): Promise<Buffer> {
  // Same ceiling as the worker: this route now decodes hostile input too.
  const pipeline = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate();

  switch (mimeType) {
    case "image/jpeg":
      return pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    case "image/png":
      // Lossless, so the merchant's master survives intact.
      return pipeline.png({ compressionLevel: 9 }).toBuffer();
    case "image/webp":
      return pipeline.webp({ quality: 92 }).toBuffer();
    case "image/avif":
      // Low effort: this one runs inside the request, not the worker.
      return pipeline.avif({ quality: 63, effort: 3 }).toBuffer();
  }
}
