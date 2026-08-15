import { NextResponse } from "next/server";

import { clearCartCoupon, setCartCoupon } from "@platform/core/cart/server";
import { z } from "zod";

import {
  CART_MUTATION_LIMIT,
  enforceBuyerRateLimit,
  errorResponse,
  newRequestId,
  parseBuyerBody,
  resolveBuyerTenant,
  tenantNotFound,
} from "../../../../lib/buyer-api";
import { readCartIdFrom } from "../../../../lib/cart-cookie";

/**
 * Coupon code on the cart (spec §7): POST stores the uppercased code,
 * DELETE clears it. Evaluation is read-only preview — the claim happens
 * only inside the confirming transaction (D8), never here.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const couponPayloadSchema = z.object({
  code: z.string().trim().min(1, { message: "Enter a coupon code." }).max(40, {
    message: "Coupon codes are at most 40 characters.",
  }),
});

function noCart(requestId: string): NextResponse {
  return NextResponse.json(
    { error: { code: "not_found", message: "That cart does not exist." }, requestId },
    { status: 404 },
  );
}

export async function POST(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const tenant = await resolveBuyerTenant(req);
    if (!tenant) return tenantNotFound(requestId);

    // Cart-mutation limit (see buyer-api.ts) — same bucket as line upserts.
    await enforceBuyerRateLimit(req, tenant.tenantId, CART_MUTATION_LIMIT);

    const cartId = readCartIdFrom(req);
    if (!cartId) return noCart(requestId);

    const parsed = await parseBuyerBody(req, couponPayloadSchema, requestId);
    if (!parsed.ok) return parsed.response;

    const cart = await setCartCoupon(
      { tenantId: tenant.tenantId, requestId },
      cartId,
      parsed.data.code,
    );
    return NextResponse.json({ cart, requestId });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const tenant = await resolveBuyerTenant(req);
    if (!tenant) return tenantNotFound(requestId);

    await enforceBuyerRateLimit(req, tenant.tenantId, CART_MUTATION_LIMIT);

    const cartId = readCartIdFrom(req);
    if (!cartId) return noCart(requestId);

    const cart = await clearCartCoupon({ tenantId: tenant.tenantId, requestId }, cartId);
    return NextResponse.json({ cart, requestId });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
