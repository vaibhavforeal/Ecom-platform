import { NextResponse } from "next/server";

import { assertCan } from "@platform/core";
import { MAX_UPLOAD_BYTES, mediaStorageKey, sha256, validateUpload } from "@platform/core/media";
import { and, desc, eq, isNull, media, withTenant } from "@platform/db";
import { getStorage } from "@platform/integrations/storage";

import { errorResponse, newRequestId } from "../../../../lib/api";
import { enqueueMediaProcessing } from "../../../../lib/queue";
import { getActorOrThrow } from "../../../../lib/session";

export const dynamic = "force-dynamic";
// Explicit: this route touches the filesystem through the local storage
// driver, which the edge runtime does not have.
export const runtime = "nodejs";

/**
 * Image upload.
 *
 * Accepts multipart/form-data with a single `file` part, validates it
 * from its own bytes, stores the original and queues derivative
 * generation. Returns as soon as the bytes are safe — encoding eighteen
 * derivatives is the worker's problem.
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

    // Checked before the body is read: `formData()` buffers the whole
    // request in memory, so an unbounded upload is a memory exhaustion
    // vector regardless of what validation says afterwards.
    const declaredLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return reject(
        "file_too_large",
        `Images must be ${MAX_UPLOAD_BYTES} bytes or smaller.`,
        413,
        requestId,
      );
    }

    const form = await req.formData().catch(() => null);
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

    const storageKey = mediaStorageKey({ tenantId, checksum, ext: validation.ext });

    /**
     * Bytes first, row second. The reverse order can leave a `pending`
     * row pointing at an object that was never written — a row the
     * worker can only ever fail on. An orphaned object costs a few
     * kilobytes and is overwritten by the next upload of the same file,
     * because the key is the checksum.
     */
    await getStorage().put(storageKey, Buffer.from(bytes), {
      contentType: validation.mimeType,
      cacheControl: ORIGINAL_CACHE_CONTROL,
    });

    const inserted = await withTenant(tenantId, async (tx) => {
      const rows = await tx
        .insert(media)
        .values({
          tenantId,
          storageKey,
          mimeType: validation.mimeType,
          byteSize: validation.byteSize,
          checksum,
          status: "pending",
          createdByUserId: actor.userId,
        })
        .returning({ id: media.id });
      return rows[0] ?? null;
    });

    if (!inserted) {
      throw new Error(`media insert returned no row for tenant ${tenantId}`);
    }

    try {
      await enqueueMediaProcessing({ tenantId, mediaId: inserted.id });
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
          .where(eq(media.id, inserted.id));
      });
      throw err;
    }

    return NextResponse.json(
      { mediaId: inserted.id, status: "pending", checksum, requestId },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
