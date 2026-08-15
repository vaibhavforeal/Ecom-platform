import { NextResponse } from "next/server";

import { NotFoundError, assertCan } from "@platform/core";
import { getOrderDetail } from "@platform/core/orders/server";

import { errorResponse, newRequestId } from "../../../../lib/api";
import { rejectMalformedId } from "../../../../lib/catalog-routes";
import { getActorOrThrow } from "../../../../lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Order detail (§7): snapshot lines, payments (with the D17 fee fields
 * for the net-settlement line), refunds, the order_events timeline
 * (newest first) and the invoice reference when issued.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const { id } = await params;
    const malformed = rejectMalformedId(id);
    if (malformed) return malformed;

    const actor = await getActorOrThrow();
    assertCan(actor, "orders:read");

    const detail = await getOrderDetail(actor.tenantId, id);
    // Another tenant's order is invisible under RLS → the same 404 as a
    // nonexistent one, which is the point.
    if (!detail) throw new NotFoundError("Order");

    return NextResponse.json({ ...detail, requestId });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
