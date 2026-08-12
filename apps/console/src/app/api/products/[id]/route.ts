import type { NextResponse } from "next/server";

import { updateProduct } from "@platform/core/catalog/server";

import { productPayloadSchema, toProductWriteInput } from "../../../../lib/catalog-input";
import { handleCatalogWrite, rejectMalformedId } from "../../../../lib/catalog-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Replace a product.
 *
 * PUT, not PATCH, and the distinction is load-bearing: the body is the
 * COMPLETE editable representation, so an omitted `description` clears
 * the column and an omitted variant is soft-deleted. Naming it PATCH
 * would invite a caller to send only what changed and silently wipe
 * everything else — which is exactly the mistake a smoke test caught
 * here before it was called PUT.
 *
 * What it does not carry is the parts of the row that are not the
 * merchant's: `createdAt`, `createdByUserId`, and the media pipeline's
 * own columns.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const malformed = rejectMalformedId(id);
  if (malformed) return malformed;

  return handleCatalogWrite(req, productPayloadSchema, (ctx, payload) =>
    updateProduct(ctx, id, toProductWriteInput(payload)),
  );
}
