import { NextResponse } from "next/server";

import { assertCan } from "@platform/core";
import { PROMOTION_STATUSES } from "@platform/core/promotions";
import type { PromotionStatus } from "@platform/core/promotions";
import { createPromotion, listPromotions } from "@platform/core/promotions/server";

import { errorResponse, newRequestId } from "../../../lib/api";
import { handleCatalogWrite } from "../../../lib/catalog-routes";
import { getActorOrThrow } from "../../../lib/session";
import { promotionPayloadSchema, toPromotionInput } from "./payload";

export const dynamic = "force-dynamic";
// The write layer reaches PostgreSQL through the postgres driver, which
// the edge runtime has no sockets for.
export const runtime = "nodejs";

/** List promotions. `promotions:read` — viewing rules moves no money. */
export async function GET(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const actor = await getActorOrThrow();
    assertCan(actor, "promotions:read");

    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status");
    const status = (PROMOTION_STATUSES as readonly string[]).includes(statusParam ?? "")
      ? (statusParam as PromotionStatus)
      : undefined;
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50;
    const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;

    const { items, total } = await listPromotions(actor.tenantId, { status, limit, offset });
    return NextResponse.json({ items, total, requestId });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}

/** Create a promotion. Tenant from the session; see handleCatalogWrite. */
export async function POST(req: Request): Promise<NextResponse> {
  return handleCatalogWrite(
    req,
    promotionPayloadSchema,
    (ctx, payload) => createPromotion(ctx, toPromotionInput(payload)),
    { permission: "promotions:write", successStatus: 201 },
  );
}
