import { NextResponse } from "next/server";

import { assertCan } from "@platform/core";
import { MAX_UPLOAD_BYTES, mediaStorageKey, sha256, validateUpload } from "@platform/core/media";
import { and, desc, eq, isNull, media, withTenant } from "@platform/db";
import { getStorage } from "@platform/integrations/storage";

import { errorResponse, newRequestId, readBoundedBody } from "../../../../lib/api";
import { sanitizeOriginal } from "../../../../lib/image";
import type { SanitizedOriginal } from "../../../../lib/image";
import { enqueueMediaProcessing } from "../../../../lib/queue";
import { getActorOrThrow } from "../../../../lib/session";

export const dynamic = "force-dynamic";
// Explicit: this route decodes images with sharp and touches the
// filesystem through the local storage driver. The edge runtime has
// neither.
export const runtime = "nodejs";

/**
 * Image upload.
 *
 * Accepts multipart/form-data with a single `file` part, validates it
 * from its own bytes, strips its metadata, stores it and queues
 * derivative generation. Returns as soon as the bytes are safe —
 * encoding eighteen derivatives is the worker's problem.
 *
 * The tenant comes from the SESSION and from nowhere else. A tenantId in
 * the body would let any authenticated merchant write into another
 * merchant's namespace, and the storage keys are tenant-prefixed, so
 * that mistake would be silent rather than loud.
 */

/**
 * Content-addressed keys: the bytes behind one can never change.
 * Immutable for as long as anything cares to cache it.
 */
const ORIGINAL_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Room for multipart framing on top of the file itself. */
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;

function reject(
  code: string,
  message: string,
  status: number,
  requestId: string,
): NextResponse {
  return NextResponse.json({ error: { code, message }, requestId }, { status });
}

export async function POST(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const actor = await getActorOrThrow();
    assertCan(actor, "catalog:write");
    const { tenantId } = actor;

    const raw = await readBoundedBody(req.body, MAX_REQUEST_BYTES);
    if (raw === "too_large") {
      return reject(
        "file_too_large",
        `Images must be ${MAX_UPLOAD_BYTES} bytes or smaller.`,
        413,
        requestId,
      );
    }

    // Re-parsed from the bounded copy. `Response.formData()` reads the
    // multipart boundary out of the content type, exactly as the request
    // would have.
    const form = raw
      ? await new Response(raw, {
          headers: { "content-type": req.headers.get("content-type") ?? "" },
        })
          .formData()
          .catch(() => null)
      : null;

    const file = form?.get("file");
    if (!form || !(file instanceof File)) {
      return reject(
        "invalid_upload",
        "Send multipart/form-data with a single `file` part.",
        400,
        requestId,
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    // `file.type` is whatever the browser felt like claiming; the check
    // inside sniffs the magic bytes and ignores it.
    const validation = validateUpload({ mimeType: file.type, byteSize: file.size, bytes });
    if (!validation.ok) {
      const status = validation.code === "file_too_large" ? 413 : 400;
      return reject(validation.code, validation.message, status, requestId);
    }

    // Of the UPLOADED bytes, not the stripped ones. Dedupe has to key on
    // what the merchant actually sent, or a change to the strip settings
    // would make every re-upload look like a new asset.
    const checksum = await sha256(bytes);

    /**
     * Dedupe. Merchants re-upload the same photograph across a dozen
     * products; each one would otherwise cost a fresh decode and
     * eighteen encodes to produce bytes that already exist.
     */
    const existing = await withTenant(tenantId, async (tx) => {
      const rows = await tx
        .select({ id: media.id, status: media.status })
        .from(media)
        .where(and(eq(media.checksum, checksum), isNull(media.deletedAt)))
        .orderBy(desc(media.createdAt))
        .limit(1);
      return rows[0] ?? null;
    });

    if (existing) {
      return NextResponse.json({
        mediaId: existing.id,
        status: existing.status,
        checksum,
        deduplicated: true,
        requestId,
      });
    }

    // Rotate, then strip, before anything is stored. See lib/image.ts —
    // the original is what the storefront links, so stripping it only in
    // the worker's derivatives publishes the merchant's GPS anyway.
    // Animated and oversized inputs are REFUSED here rather than
    // flattened or decoded, each with its own code.
    let sanitized: SanitizedOriginal;
    try {
      sanitized = await sanitizeOriginal(bytes, validation.mimeType);
    } catch (err) {
      // Sniffed as an image but will not decode: a bomb, or a truncated
      // upload. Neither is a server fault.
      console.warn(
        JSON.stringify({
          level: "warn",
          requestId,
          event: "media.sanitize_failed",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return reject("invalid_image", "That image could not be read.", 400, requestId);
    }

    if (!sanitized.ok) {
      const status = sanitized.code === "image_too_large" ? 413 : 400;
      return reject(sanitized.code, sanitized.message, status, requestId);
    }

    const original = sanitized.bytes;

    const storageKey = mediaStorageKey({ tenantId, checksum, ext: validation.ext });

    /**
     * Bytes first, row second. The reverse order can leave a `pending`
     * row pointing at an object that was never written — a row the
     * worker can only ever fail on. An orphaned object costs a few
     * kilobytes and is overwritten by the next upload of the same file,
     * because the key is the checksum.
     */
    await getStorage().put(storageKey, original, {
      contentType: validation.mimeType,
      cacheControl: ORIGINAL_CACHE_CONTROL,
    });

    /**
     * `onConflictDoNothing` on the (tenant, storage_key) unique index.
     * Two cases land here, and both were a 500 before:
     *
     *  · Two uploads of the same file racing — the dedupe SELECT above
     *    is not atomic with this insert.
     *  · A SOFT-DELETED row for the same file. The dedupe SELECT filters
     *    `deleted_at IS NULL`; the unique index has no such predicate.
     *    So once media deletion exists, re-uploading a previously
     *    deleted file collides — permanently, for that one file.
     */
    const inserted = await withTenant(tenantId, async (tx) => {
      const rows = await tx
        .insert(media)
        .values({
          tenantId,
          storageKey,
          mimeType: validation.mimeType,
          // The size of what was STORED. `validation.byteSize` is the
          // upload's size, which is not what now sits at this key.
          byteSize: original.length,
          checksum,
          status: "pending",
          createdByUserId: actor.userId,
        })
        .onConflictDoNothing({ target: [media.tenantId, media.storageKey] })
        .returning({ id: media.id });
      return rows[0] ?? null;
    });

    let mediaId: string;

    if (inserted) {
      mediaId = inserted.id;
    } else {
      const claimed = await withTenant(tenantId, async (tx) => {
        const rows = await tx
          .select({ id: media.id, status: media.status, deletedAt: media.deletedAt })
          .from(media)
          .where(eq(media.storageKey, storageKey))
          .limit(1);
        return rows[0] ?? null;
      });

      if (!claimed) {
        // The conflicting row is invisible under this tenant's RLS
        // context, which cannot happen for a tenant-prefixed key.
        throw new Error(`media insert conflicted on an unreadable row for tenant ${tenantId}`);
      }

      if (!claimed.deletedAt) {
        // A concurrent upload of the same file won. Same answer the
        // dedupe branch would have given a moment earlier.
        return NextResponse.json({
          mediaId: claimed.id,
          status: claimed.status,
          checksum,
          deduplicated: true,
          requestId,
        });
      }

      // Soft-deleted, and the merchant has just uploaded the file again.
      // Undelete and reprocess: plainly what they asked for, and the
      // alternative is a 500 that never stops happening for that file.
      await withTenant(tenantId, async (tx) => {
        await tx
          .update(media)
          .set({
            deletedAt: null,
            status: "pending",
            processingError: null,
            derivatives: [],
            mimeType: validation.mimeType,
            byteSize: original.length,
            checksum,
            updatedAt: new Date(),
          })
          .where(eq(media.id, claimed.id));
      });
      mediaId = claimed.id;
    }

    try {
      await enqueueMediaProcessing({ tenantId, mediaId });
    } catch (err) {
      // Redis is down. Without this the row sits `pending` forever and
      // nothing anywhere says so.
      await withTenant(tenantId, async (tx) => {
        await tx
          .update(media)
          .set({
            status: "failed",
            processingError: "Could not queue processing.",
            updatedAt: new Date(),
          })
          .where(eq(media.id, mediaId));
      });
      throw err;
    }

    return NextResponse.json(
      { mediaId, status: "pending", checksum, requestId },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
