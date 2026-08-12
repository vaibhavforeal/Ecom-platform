import { NextResponse } from "next/server";

import { assertCan } from "@platform/core";
import { CsvFormatError, CsvRecordReader, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS } from "@platform/core/catalog";
import { runCatalogImport } from "@platform/core/catalog/server";

import { errorResponse, newRequestId } from "../../../../lib/api";
import { getActorOrThrow, requestContext } from "../../../../lib/session";

export const dynamic = "force-dynamic";
// The importer reaches PostgreSQL through the postgres driver, which the
// edge runtime has no sockets for.
export const runtime = "nodejs";

/**
 * Bulk catalog import.
 *
 * The body is the CSV itself — `text/csv`, not multipart. Multipart
 * would mean buffering the whole upload to find the part boundary before
 * a single row could be parsed, which is the opposite of what a file
 * this size wants; sending the file as the body lets the parser consume
 * it off the socket and stop the instant a cap is hit.
 *
 * DRY RUN unless `?commit=true`. The merchant sees a report first and
 * confirms it, because the alternative is finding out what an import
 * does by having it done.
 *
 * The tenant comes from the SESSION. A `tenant_id` column in the file is
 * an unrecognised header, which the parser ignores rather than honours.
 */

type Rejection = { code: string; message: string; status: number };

function reject(rejection: Rejection, requestId: string): NextResponse {
  return NextResponse.json(
    { error: { code: rejection.code, message: rejection.message }, requestId },
    { status: rejection.status },
  );
}

/**
 * Reads the upload into records, counting bytes off the socket as it
 * goes and hanging up the moment either cap is passed.
 *
 * A `Content-Length` pre-check does NOT close this: the header is absent
 * on chunked transfers and on ordinary HTTP/2, and `Number(null ?? "0")`
 * is 0, which passes every comparison. The only number worth trusting is
 * the one counted here.
 */
async function readRecords(
  body: ReadableStream<Uint8Array> | null,
): Promise<{ records: string[][] } | { rejection: Rejection }> {
  if (!body) return { records: [] };

  const reader = body.getReader();
  // `ignoreBOM` defaults to false, which means the decoder REMOVES a
  // leading BOM — Excel writes one on every CSV it saves, and left in
  // place it becomes part of the first column's name. The CSV reader
  // strips one too; whichever gets there first, `handle` stays `handle`.
  const decoder = new TextDecoder("utf-8");
  const csv = new CsvRecordReader();
  const records: string[][] = [];
  let bytes = 0;

  const stop = async (rejection: Rejection): Promise<{ rejection: Rejection }> => {
    // Hang up rather than draining bytes already decided against.
    await reader.cancel().catch(() => undefined);
    return { rejection };
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      bytes += value.byteLength;
      if (bytes > MAX_IMPORT_BYTES) {
        return await stop({
          code: "file_too_large",
          message: `A catalog file must be ${MAX_IMPORT_BYTES} bytes or smaller.`,
          status: 413,
        });
      }

      for (const record of csv.push(decoder.decode(value, { stream: true }))) {
        records.push(record);
        // +1 for the header row.
        if (records.length > MAX_IMPORT_ROWS + 1) {
          return await stop({
            code: "too_many_rows",
            message: `An import can carry at most ${MAX_IMPORT_ROWS} rows. Split the file.`,
            status: 413,
          });
        }
      }
    }

    // Flushes a multi-byte character split across the last chunk
    // boundary, which is otherwise silently replaced with U+FFFD.
    const tail = decoder.decode();
    if (tail !== "") records.push(...csv.push(tail));
    records.push(...csv.end());
  } catch (err) {
    if (err instanceof CsvFormatError) {
      return { rejection: { code: "invalid_csv", message: err.message, status: 400 } };
    }
    throw err;
  }

  return { records };
}

export async function POST(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();

  try {
    // Authentication and authorisation BEFORE a byte of the body is
    // read, so an unauthenticated upload costs nothing to refuse.
    const actor = await getActorOrThrow();
    assertCan(actor, "catalog:write");

    const read = await readRecords(req.body);
    if ("rejection" in read) return reject(read.rejection, requestId);

    if (read.records.length === 0) {
      return reject(
        { code: "empty_file", message: "That file has nothing in it.", status: 400 },
        requestId,
      );
    }

    // Explicit confirmation, and nothing else counts as it.
    const commit = new URL(req.url).searchParams.get("commit") === "true";

    const { ip, userAgent } = await requestContext();

    const report = await runCatalogImport(
      { tenantId: actor.tenantId, actorUserId: actor.userId, ip, userAgent, requestId },
      read.records,
      { commit },
    );

    // 422 whenever the file has something wrong with it, whether or not
    // a commit was asked for — the report is the body either way, so the
    // console renders one thing and `curl` still gets an honest status.
    return NextResponse.json(
      { report, requestId },
      { status: report.issues.length > 0 ? 422 : 200 },
    );
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
