import type { NextResponse } from "next/server";

import { createCollection } from "@platform/core/catalog/server";

import { taxonomyPayloadSchema, toTaxonomyWriteInput } from "../../../lib/catalog-input";
import { handleCatalogWrite } from "../../../lib/catalog-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  return handleCatalogWrite(
    req,
    taxonomyPayloadSchema,
    (ctx, payload) => createCollection(ctx, toTaxonomyWriteInput(payload)),
    { successStatus: 201 },
  );
}
