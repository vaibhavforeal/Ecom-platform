import type { NextResponse } from "next/server";

import { updateCategory } from "@platform/core/catalog/server";

import { taxonomyPayloadSchema, toTaxonomyWriteInput } from "../../../../lib/catalog-input";
import { handleCatalogWrite, rejectMalformedId } from "../../../../lib/catalog-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Replace a category. As with products, the body is the whole of it. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const malformed = rejectMalformedId(id);
  if (malformed) return malformed;

  return handleCatalogWrite(req, taxonomyPayloadSchema, (ctx, payload) =>
    updateCategory(ctx, id, toTaxonomyWriteInput(payload)),
  );
}
