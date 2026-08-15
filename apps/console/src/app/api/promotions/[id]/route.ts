import { NextResponse } from "next/server";

import { NotFoundError, assertCan } from "@platform/core";
import {
  archivePromotion,
  getPromotion,
  updatePromotion,
} from "@platform/core/promotions/server";
import { z } from "zod";

import { errorResponse, newRequestId } from "../../../../lib/api";
import { handleCatalogWrite, rejectMalformedId } from "../../../../lib/catalog-routes";
import { getActorOrThrow } from "../../../../lib/session";
import { promotionPayloadSchema, toPromotionInput } from "../payload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One promotion, rules included, for the edit form. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const malformed = rejectMalformedId(id);
  if (malformed) return malformed;

  const requestId = newRequestId();
  try {
    const actor = await getActorOrThrow();
    assertCan(actor, "promotions:read");

    const promotion = await getPromotion(actor.tenantId, id);
    // Another merchant's promotion is invisible under this tenant's RLS
    // context, so a cross-tenant id lands here as a plain 404.
    if (!promotion) throw new NotFoundError("Promotion");

    return NextResponse.json({ ...promotion, requestId });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}

/**
 * Replace a promotion. PUT: the body is the COMPLETE editable
 * representation (the products precedent) — an omitted window clears it.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const malformed = rejectMalformedId(id);
  if (malformed) return malformed;

  return handleCatalogWrite(
    req,
    promotionPayloadSchema,
    (ctx, payload) => updatePromotion(ctx, id, toPromotionInput(payload)),
    { permission: "promotions:write" },
  );
}

/**
 * DELETE archives (design §7): a promotion referenced by orders is
 * history, never erased. Carries no payload.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const malformed = rejectMalformedId(id);
  if (malformed) return malformed;

  return handleCatalogWrite(
    req,
    z.unknown(),
    async (ctx) => {
      await archivePromotion(ctx, id);
      return { archived: true };
    },
    { permission: "promotions:write" },
  );
}
