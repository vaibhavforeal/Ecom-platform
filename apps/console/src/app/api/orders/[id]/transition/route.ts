import type { NextResponse } from "next/server";

import { MANUAL_ORDER_TRANSITIONS } from "@platform/core/orders";
import type { OrderStatus } from "@platform/core/orders";
import { manualTransition } from "@platform/core/orders/server";
import { z } from "zod";

import { handleCatalogWrite, rejectMalformedId } from "../../../../../lib/catalog-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The manual fulfilment ladder (D12/§4.8). The payload enum is derived
 * from the SAME allowlist the domain door enforces — the zod check is
 * convenience, `manualTransition`'s allowlist + transition table is the
 * wall. RTO/return targets are not in the allowlist, so they cannot be
 * named here at all.
 */
const MANUAL_TARGETS = [...new Set(MANUAL_ORDER_TRANSITIONS.map((t) => t.to))] as [
  OrderStatus,
  ...OrderStatus[],
];

const transitionPayloadSchema = z.object({
  to: z.enum(MANUAL_TARGETS),
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
    transitionPayloadSchema,
    (ctx, payload) => manualTransition(ctx, id, payload.to),
    { permission: "orders:write" },
  );
}
