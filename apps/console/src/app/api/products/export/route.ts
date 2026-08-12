import { assertCan } from "@platform/core";
import { catalogExportFilename, exportCatalogCsv } from "@platform/core/catalog/server";

import { errorResponse, newRequestId } from "../../../../lib/api";
import { getActorOrThrow } from "../../../../lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The tenant's whole catalog as CSV, streamed.
 *
 * Streamed rather than assembled: a few thousand products is several
 * megabytes, and building the string first means the merchant's browser
 * waits for the last database page before the first byte arrives, while
 * the server holds the entire file in memory to no purpose.
 *
 * `catalog:read`, not `catalog:write` — this is the merchant's own data
 * and anyone who can see the product list can already see all of it.
 */
export async function GET(): Promise<Response> {
  const requestId = newRequestId();

  try {
    const actor = await getActorOrThrow();
    assertCan(actor, "catalog:read");

    const rows = exportCatalogCsv(actor.tenantId)[Symbol.asyncIterator]();
    const encoder = new TextEncoder();

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await rows.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(value));
      },
      async cancel() {
        // The merchant closed the tab mid-download. Without this the
        // generator is left suspended holding its page cursor.
        await rows.return?.(undefined);
      },
    });

    return new Response(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        // The filename is composed entirely of characters this app
        // chose; a merchant-supplied one here is header injection.
        "content-disposition": `attachment; filename="${catalogExportFilename()}"`,
        // A catalog changes; a cached copy of yesterday's is worse than
        // no copy, and this one is per-tenant.
        "cache-control": "no-store, private",
        "x-request-id": requestId,
      },
    });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
