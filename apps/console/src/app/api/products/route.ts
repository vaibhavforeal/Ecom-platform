import type { NextResponse } from "next/server";

import { createProduct } from "@platform/core/catalog/server";

import { productPayloadSchema, toProductWriteInput } from "../../../lib/catalog-input";
import { handleCatalogWrite } from "../../../lib/catalog-routes";

export const dynamic = "force-dynamic";
// The write layer reaches PostgreSQL through the postgres driver, which
// the edge runtime has no sockets for.
export const runtime = "nodejs";

/** Create a product. Tenant from the session; see handleCatalogWrite. */
export async function POST(req: Request): Promise<NextResponse> {
  return handleCatalogWrite(
    req,
    productPayloadSchema,
    (ctx, payload) => createProduct(ctx, toProductWriteInput(payload)),
    { successStatus: 201 },
  );
}
