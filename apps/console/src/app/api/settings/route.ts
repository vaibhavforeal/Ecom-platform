import type { NextResponse } from "next/server";

import { updateSearchIndexing } from "@platform/core";
import { SEARCH_INDEXING_MODES } from "@platform/db";
import { z } from "zod";

import { handleCatalogWrite } from "../../../lib/catalog-routes";

/**
 * Tenant settings. One field today; later settings join this schema.
 *
 * The tenant is the session's — `handleCatalogWrite` builds the write
 * context from the actor and there is no way to pass a tenant in the
 * body. That matters more than usual here: `tenants` has no RLS, so the
 * domain function's WHERE clause is the only isolation.
 */
const settingsPayloadSchema = z.object({
  searchIndexing: z.enum(SEARCH_INDEXING_MODES),
});

export async function PUT(req: Request): Promise<NextResponse> {
  return handleCatalogWrite(
    req,
    settingsPayloadSchema,
    (ctx, payload) => updateSearchIndexing(ctx, payload.searchIndexing),
    { permission: "settings:write" },
  );
}
