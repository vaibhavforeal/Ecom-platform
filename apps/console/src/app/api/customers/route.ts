import { NextResponse } from "next/server";

import { assertCan } from "@platform/core";
import { listCustomers } from "@platform/core/customers/server";
import { z } from "zod";

import { errorResponse, newRequestId } from "../../../lib/api";
import { getActorOrThrow } from "../../../lib/session";

/**
 * GET /api/customers (spec §7, design D14): the read-only list behind
 * `customers:read`. Tenant from the SESSION, never a parameter; the
 * order count is an aggregate query inside the domain layer, not a
 * counter column.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const listQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function GET(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();

  try {
    const actor = await getActorOrThrow();
    assertCan(actor, "customers:read");

    const url = new URL(req.url);
    const parsed = listQuerySchema.safeParse({
      q: url.searchParams.get("q") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: "invalid_payload",
            message: "Some query parameters need attention.",
            details: {
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path.join(".") || "query",
                message: issue.message,
              })),
            },
          },
          requestId,
        },
        { status: 422 },
      );
    }

    const { items, total } = await listCustomers(actor.tenantId, parsed.data);
    return NextResponse.json({ items, total, requestId });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
