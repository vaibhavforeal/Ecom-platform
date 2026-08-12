import sharp from "sharp";
import type { Sharp } from "sharp";

import { derivativeStorageKey, planDerivatives, sha256 } from "@platform/core/media";
import type { ImageFormat, MediaDerivative } from "@platform/core/media";
import { eq, media, withTenant } from "@platform/db";
import { getStorage } from "@platform/integrations/storage";

import type { TenantJob } from "../queues";

/**
 * Derivative generation.
 *
 * The upload endpoint stores the original and inserts a `pending` row;
 * this turns that into the AVIF/WebP/JPEG ladder the storefront's
 * `srcset` reads. It runs here rather than in the request because
 * encoding eighteen images is seconds of CPU, and a merchant's browser
 * upload must not hold a web worker — or a database connection — open
 * for the duration (PLATFORM_BLUEPRINT.md §5.3).
 */

export type ProcessMediaJob = TenantJob<{ mediaId: string }>;

/**
 * Decompression-bomb ceiling.
 *
 * A 4 KB PNG can declare 50000×50000 and expand to gigabytes on decode.
 * Without this the first such upload OOM-kills the worker process —
 * which is shared, so one hostile tenant stops image processing for
 * every merchant on the platform at once.
 */
const MAX_INPUT_PIXELS = 50_000_000;

const CONTENT_TYPE: Record<ImageFormat, string> = {
  avif: "image/avif",
  webp: "image/webp",
  jpeg: "image/jpeg",
};

/**
 * Derivative keys are content-addressed (checksum + width + format), so
 * the bytes behind a key can never change. That makes them immutable
 * for as long as anyone cares to cache them.
 */
const DERIVATIVE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Postgres would take more, but a stack trace is not a UI string. */
const MAX_ERROR_LENGTH = 1_000;

function encode(pipeline: Sharp, format: ImageFormat): Sharp {
  switch (format) {
    case "avif":
      // effort 4 of 9: the last few points cost seconds per image for
      // single-digit percentages of size.
      return pipeline.avif({ quality: 50, effort: 4 });
    case "webp":
      return pipeline.webp({ quality: 78 });
    case "jpeg":
      return pipeline.jpeg({ quality: 80, mozjpeg: true, progressive: true });
  }
}

export async function processMedia(
  job: ProcessMediaJob,
): Promise<{ width: number; height: number; derivatives: number }> {
  const { tenantId, mediaId } = job;

  // Contract: tenant context first, before touching any tenant data.
  const row = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        storageKey: media.storageKey,
        checksum: media.checksum,
      })
      .from(media)
      .where(eq(media.id, mediaId))
      .limit(1);
    return rows[0] ?? null;
  });

  // RLS returns zero rows — not an error — when the id belongs to
  // another tenant, so "not found" here is either a deleted row or a
  // cross-tenant enqueue. Both deserve to be loud.
  if (!row) {
    throw new Error(`media ${mediaId} not found for tenant ${tenantId}`);
  }

  try {
    const storage = getStorage();
    const bytes = await storage.get(row.storageKey);

    const metadata = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error(`Could not read image dimensions from ${row.storageKey}`);
    }

    /**
     * EXIF Orientation 5-8 mean the stored pixels are rotated a quarter
     * turn from how the photo should be displayed. `sharp.rotate()`
     * applies that below, so the INTRINSIC dimensions — the ones the
     * plan and the storefront's `width`/`height` attributes must use —
     * have their axes swapped. Skip this and every portrait phone photo
     * is planned and labelled as a landscape one.
     */
    const swapsAxes = (metadata.orientation ?? 1) >= 5;
    const width = swapsAxes ? metadata.height : metadata.width;
    const height = swapsAxes ? metadata.width : metadata.height;

    // A row inserted without one (never by the upload endpoint, but the
    // column is nullable) still needs a stable key namespace.
    const checksum = row.checksum ?? (await sha256(bytes));

    const derivatives: MediaDerivative[] = [];

    for (const entry of planDerivatives({ width, height })) {
      const pipeline = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
        // .rotate() with no argument applies EXIF Orientation and then
        // drops the tag, so the output is upright for viewers that
        // ignore EXIF entirely.
        .rotate()
        // Never enlarge: a 100px logo planned at 320 comes out at 100,
        // and the ACTUAL output size below is what gets recorded.
        .resize({ width: entry.width, withoutEnlargement: true });

      // sharp writes no EXIF/XMP/IPTC unless explicitly asked to keep
      // it. That default is the privacy control here: phone photos
      // carry GPS coordinates, and publishing a merchant's home
      // location on their own product page is a breach they will never
      // think to check for. Do not add .keepMetadata()/.withMetadata().
      const output = await encode(pipeline, entry.format).toBuffer({ resolveWithObject: true });

      const stored = await storage.put(
        derivativeStorageKey({
          tenantId,
          checksum,
          width: output.info.width,
          format: entry.format,
        }),
        output.data,
        { contentType: CONTENT_TYPE[entry.format], cacheControl: DERIVATIVE_CACHE_CONTROL },
      );

      derivatives.push({
        format: entry.format,
        width: output.info.width,
        height: output.info.height,
        storageKey: stored.key,
        byteSize: stored.byteSize,
      });
    }

    await withTenant(tenantId, async (tx) => {
      await tx
        .update(media)
        .set({
          status: "ready",
          width,
          height,
          checksum,
          derivatives,
          processingError: null,
          updatedAt: new Date(),
        })
        .where(eq(media.id, mediaId));
    });

    return { width, height, derivatives: derivatives.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    /**
     * Mark the row before rethrowing. A row left `pending` forever is
     * invisible breakage: the console shows a spinner, nobody is
     * alerted, and the merchant concludes the product page is broken.
     * The rethrow is what makes BullMQ retry with the queue's backoff
     * and eventually record a dead letter.
     */
    try {
      await withTenant(tenantId, async (tx) => {
        await tx
          .update(media)
          .set({
            status: "failed",
            processingError: message.slice(0, MAX_ERROR_LENGTH),
            updatedAt: new Date(),
          })
          .where(eq(media.id, mediaId));
      });
    } catch (markErr) {
      // Never let the bookkeeping failure hide the real one.
      console.error(
        JSON.stringify({
          level: "error",
          event: "media.mark_failed_failed",
          tenantId,
          mediaId,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        }),
      );
    }

    throw err;
  }
}
