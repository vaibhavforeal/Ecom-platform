import type { NextResponse } from "next/server";

import { cancelOrder } from "@platform/core/checkout/server";
import { z } from "zod";

import { handleCatalogWrite, rejectMalformedId } from "../../../../../lib/catalog-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Console cancel (§4.7) — its OWN permission, `orders:cancel`, split
 * from `orders:write`: moving an order forward is fulfilment, cancelling
 * it moves money (restock + refund intent). The orchestration lives in
 * checkout/server (B-INT) because it spans inventory, refunds and the
 * transition door.
 */
const cancelPayloadSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const malformed = rejectMalformedId(id);
  if (malformed) return malformed;

  return handleCatalogWrite(
    req,
    cancelPayloadSchema,
    async (ctx, payload) => {
      await cancelOrder(ctx, id, { reason: payload.reason ?? null });
      return { cancelled: true };
    },
    { permission: "orders:cancel" },
  );
}
