import sharp from "sharp";
import type { Sharp } from "sharp";

import { catalogPurgeTags } from "@platform/core/catalog";
import { purgeStorefrontCache } from "@platform/core/catalog/server";
import {
  MAX_IMAGE_PIXELS,
  derivativeStorageKey,
  planDerivatives,
  sha256,
} from "@platform/core/media";
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

/**
 * Is this error a 23505 constraint violation on media_tenant_checksum_idx?
 *
 * Drizzle wraps postgres.js errors but the constraint properties remain
 * accessible on the error object itself (observed in test failure output).
 * We also check err.cause in case it's wrapped.
 */
function isChecksumCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint_name?: string; cause?: unknown };

  // Check the error itself
  if (e.code === "23505" && e.constraint_name === "media_tenant_checksum_idx") {
    return true;
  }

  // Check the cause chain
  if (e.cause && typeof e.cause === "object") {
    const cause = e.cause as { code?: string; constraint_name?: string };
    if (cause.code === "23505" && cause.constraint_name === "media_tenant_checksum_idx") {
      return true;
    }
  }

  return false;
}

/**
 * processing_error feeds the merchant's screen verbatim (ProductForm
 * renders it), so it holds curated sentences only. The raw error goes
 * to the structured log where an operator can see it.
 */
function merchantFailureReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/pixel limit|exceeds.*pixel/i.test(raw))
    return "The image exceeds the pixel limit for processing.";
  if (/unsupported image format|source file|corrupt|premature end|invalid/i.test(raw))
    return "The file could not be decoded as an image.";
  if (/ENOENT|NoSuchKey|not found/i.test(raw))
    return "The original file could not be read from storage.";
  return "Processing failed inside the platform. Uploading the same file again retries it.";
}

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

export type ProcessMediaResult = { width: number; height: number; derivatives: number };

/**
 * Encodes the ladder, then tells the storefront to drop what it cached.
 *
 * THE PURGE IS NOT OPTIONAL BOOKKEEPING. The console's save is what
 * purges on the write path, and it runs while this row is still
 * `pending` — so the storefront re-caches the placeholder: a card with
 * no image, a hero-less PDP, and JSON-LD/OG tags with no `image`. This
 * job finishes seconds later and nothing else purges, so that page stays
 * live for the full 300s TTL with no way for the merchant to force it.
 *
 * Tenant-wide tags rather than per-product: a media row can hang off any
 * number of products and this job does not know which, so the narrower
 * tags would be the wrong set rather than a cheaper one.
 *
 * Sequenced OUTSIDE the try/catch below, deliberately twice over.
 * `purgeStorefrontCache` never throws — refused connection, 500,
 * timeout, malformed origin all end in its own catch — but if it ever
 * did, throwing inside that block would mark a row `failed` that is in
 * fact `ready`, which is worse than a stale cache. Rule 2 of
 * `catalog/purge.ts`: a failed purge must never fail the write.
 */
export async function processMedia(job: ProcessMediaJob): Promise<ProcessMediaResult> {
  const result = await generateDerivatives(job);
  await purgeStorefrontCache(job.tenantId, catalogPurgeTags(job.tenantId));
  return result;
}

async function generateDerivatives(job: ProcessMediaJob): Promise<ProcessMediaResult> {
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

    const metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    if (!metadata.width || !metadata.height) {
      // Log the storage key separately — it must not reach processing_error.
      console.error(JSON.stringify({
        level: "error",
        event: "media.dimension_read_failed",
        mediaId, tenantId, storageKey: row.storageKey,
      }));
      throw new Error("Could not read the image's dimensions.");
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
      const pipeline = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
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

    const markReady = async (checksumValue: string | null) => {
      await withTenant(tenantId, async (tx) => {
        await tx
          .update(media)
          .set({
            status: "ready",
            width,
            height,
            checksum: checksumValue,
            derivatives,
            processingError: null,
            updatedAt: new Date(),
          })
          .where(eq(media.id, mediaId));
      });
    };

    try {
      await markReady(checksum);
    } catch (err) {
      if (!isChecksumCollision(err)) throw err;
      // Another row in this tenant already owns these bytes' checksum —
      // possible only on backfill (the upload route dedupes by checksum
      // before inserting). The derivatives are already built and stored;
      // completing the row with a NULL checksum keeps it working. NULLs
      // are distinct under media_tenant_checksum_idx, so this cannot
      // collide. The row simply never participates in dedupe.
      console.warn(JSON.stringify({
        level: "warn",
        event: "media.checksum_collision_adopted",
        mediaId, tenantId, checksum,
      }));
      await markReady(null);
    }

    return { width, height, derivatives: derivatives.length };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);

    // Log the raw error for operators; the merchant sees only the curated sentence.
    console.error(JSON.stringify({
      level: "error",
      event: "media.processing_failed",
      mediaId, tenantId,
      message: rawMessage,
    }));

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
            processingError: merchantFailureReason(err).slice(0, MAX_ERROR_LENGTH),
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
