import type { NextResponse } from "next/server";

import { STOCK_ADJUSTMENT_MAX } from "@platform/core/inventory";
import { recordMovement } from "@platform/core/inventory/server";
import { z } from "zod";

import { handleCatalogWrite } from "../../../../lib/catalog-routes";

/**
 * The adjust endpoint — the ONLY HTTP writer of stock_movements.
 *
 * The note is required here even though the column is nullable: a
 * merchant-initiated movement without a note is an audit answer that
 * says nothing; future automated movements (orders, RTO) carry
 * references instead and use recordMovement directly.
 */
const movementPayloadSchema = z.object({
  variantId: z.string().uuid(),
  delta: z
    .number()
    .int()
    .refine((d) => d !== 0, { message: "Enter a nonzero whole number." })
    .refine((d) => Math.abs(d) <= STOCK_ADJUSTMENT_MAX, {
      message: `Adjustments are capped at ${STOCK_ADJUSTMENT_MAX.toLocaleString("en-IN")}.`,
    }),
  note: z.string().trim().min(1, { message: "A note is required." }).max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  return handleCatalogWrite(
    req,
    movementPayloadSchema,
    (ctx, payload) => recordMovement(ctx, payload),
    { permission: "inventory:write", successStatus: 201 },
  );
}
