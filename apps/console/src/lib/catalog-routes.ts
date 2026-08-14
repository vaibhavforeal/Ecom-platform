import { NextResponse } from "next/server";

import { assertCan } from "@platform/core";
import type { Permission } from "@platform/core";
import type { WriteContext } from "@platform/core/catalog/server";
import type { z } from "zod";

import { errorResponse, newRequestId, readBoundedBody } from "./api";
import { zodIssues } from "./catalog-input";
import { getActorOrThrow, requestContext } from "./session";

/**
 * The shape every catalog write route has in common.
 *
 * Four routes doing authenticate → authorise → bound → parse → write →
 * audit is four chances to leave one of those out. Factored here, the
 * order is fixed and a new route cannot get it wrong by omission: the
 * only thing a caller supplies is the schema and what to do with the
 * parsed value.
 */

/**
 * A generous ceiling for a JSON catalog payload and a hard one for a
 * hostile request.
 *
 * A 200-variant product with long descriptions lands around 200 kB.
 * Anything over a megabyte is not a product.
 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

export type CatalogWriteHandler<TInput, TOutput> = (
  ctx: WriteContext,
  input: TInput,
) => Promise<TOutput>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A 404 for a path id that is not a uuid, or null to carry on.
 *
 * Checked before the id reaches a query: `withTenant`'s own guard is for
 * the tenant, and a malformed entity id would otherwise surface as an
 * opaque `invalid input syntax for type uuid` 500 rather than as the
 * 404 it plainly is.
 */
export function rejectMalformedId(id: string): NextResponse | null {
  if (UUID_RE.test(id)) return null;
  return NextResponse.json(
    { error: { code: "not_found", message: "That does not exist." }, requestId: newRequestId() },
    { status: 404 },
  );
}

/**
 * Runs a catalog mutation with every guard in place.
 *
 * The tenant is taken from the SESSION. It is not a parameter of this
 * function and there is no way to pass one — a tenantId in the body
 * would let any authenticated merchant write into another merchant's
 * catalog, and because the tables are RLS-protected the mistake would
 * show up as "no data" rather than as an error.
 *
 * Despite the name, the pipeline is not catalog-specific: `opts.permission`
 * lets a non-catalog route (settings) reuse it with its own gate.
 */
export async function handleCatalogWrite<TSchema extends z.ZodTypeAny, TOutput>(
  req: Request,
  schema: TSchema,
  run: CatalogWriteHandler<z.infer<TSchema>, TOutput>,
  opts: { successStatus?: number; permission?: Permission } = {},
): Promise<NextResponse> {
  const requestId = newRequestId();

  try {
    const actor = await getActorOrThrow();
    assertCan(actor, opts.permission ?? "catalog:write");

    const raw = await readBoundedBody(req.body, MAX_JSON_BODY_BYTES);
    if (raw === "too_large") {
      return NextResponse.json(
        {
          error: {
            code: "payload_too_large",
            message: `Catalog payloads must be ${MAX_JSON_BODY_BYTES} bytes or smaller.`,
          },
          requestId,
        },
        { status: 413 },
      );
    }

    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return NextResponse.json(
          { error: { code: "invalid_json", message: "Send a JSON body." }, requestId },
          { status: 400 },
        );
      }
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      // 422, and the same `{ path, message }` shape the domain's own
      // validation returns, so the form has one renderer rather than a
      // branch that gets the second case wrong.
      return NextResponse.json(
        {
          error: {
            code: "invalid_payload",
            message: "Some fields need attention.",
            details: { issues: zodIssues(parsed.error) },
          },
          requestId,
        },
        { status: 422 },
      );
    }

    const { ip, userAgent } = await requestContext();

    const result = await run(
      {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        ip,
        userAgent,
        requestId,
      },
      parsed.data,
    );

    return NextResponse.json({ ...result, requestId }, { status: opts.successStatus ?? 200 });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
