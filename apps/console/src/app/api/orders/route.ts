import { NextResponse } from "next/server";

import { assertCan } from "@platform/core";
import { ORDER_STATUSES } from "@platform/core/orders";
import type { OrderStatus } from "@platform/core/orders";
import { listOrders } from "@platform/core/orders/server";

import { errorResponse, newRequestId } from "../../../lib/api";
import { getActorOrThrow } from "../../../lib/session";

export const dynamic = "force-dynamic";
// The read layer reaches PostgreSQL through the postgres driver, which
// the edge runtime has no sockets for.
export const runtime = "nodejs";

/**
 * The orders list (§7): `status?, q?, limit, offset`. Tenant from the
 * session — reads carry the same rule as writes.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const actor = await getActorOrThrow();
    assertCan(actor, "orders:read");

    const params = new URL(req.url).searchParams;

    const rawStatus = params.get("status");
    if (rawStatus !== null && !(ORDER_STATUSES as readonly string[]).includes(rawStatus)) {
      return NextResponse.json(
        {
          error: {
            code: "invalid_payload",
            message: "Some fields need attention.",
            details: { issues: [{ path: "status", message: "Unknown order status." }] },
          },
          requestId,
        },
        { status: 422 },
      );
    }

    const q = params.get("q")?.slice(0, 120) || undefined;
    const limit = Math.min(
      Math.max(Number.parseInt(params.get("limit") ?? "50", 10) || 50, 1),
      100,
    );
    const offset = Math.max(Number.parseInt(params.get("offset") ?? "0", 10) || 0, 0);

    const result = await listOrders(actor.tenantId, {
      status: (rawStatus ?? undefined) as OrderStatus | undefined,
      q,
      limit,
      offset,
    });
    return NextResponse.json({ ...result, requestId });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
