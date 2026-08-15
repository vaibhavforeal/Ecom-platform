import { NextResponse } from "next/server";

import { CART_LINE_MAX_QUANTITY } from "@platform/core/cart";
import { getCartView, getOrCreateCart, upsertLine } from "@platform/core/cart/server";
import { z } from "zod";

import {
  errorResponse,
  newRequestId,
  parseBuyerBody,
  resolveBuyerTenant,
  tenantNotFound,
} from "../../../lib/buyer-api";
import { readCartIdFrom, setCartCookie } from "../../../lib/cart-cookie";

/**
 * The cart door (spec §7, §4.1): GET the live view, POST an upsert.
 *
 * Live commerce reads are NEVER cached — no unstable_cache anywhere on
 * this path, and the route is force-dynamic. Tenant from the Host, cart
 * identity from the httpOnly cookie, and nothing else is trusted: the
 * variant id in the payload is verified with a visibility SELECT inside
 * the domain transaction.
 */

export const dynamic = "force-dynamic";
// The domain layer reaches PostgreSQL through the postgres driver, which
// the edge runtime has no sockets for.
export const runtime = "nodejs";

/** quantity 0 = remove the line (spec §7). */
const upsertPayloadSchema = z.object({
  variantId: z.string().uuid({ message: "That variant does not exist." }),
  quantity: z
    .number()
    .int({ message: "Quantity must be a whole number." })
    .min(0)
    .max(CART_LINE_MAX_QUANTITY, {
      message: `Quantity is capped at ${CART_LINE_MAX_QUANTITY}.`,
    }),
});

export async function GET(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const tenant = await resolveBuyerTenant(req);
    if (!tenant) return tenantNotFound(requestId);

    const cartId = readCartIdFrom(req);
    const cart = cartId
      ? await getCartView({ tenantId: tenant.tenantId, requestId }, cartId)
      : null;

    // A stale cookie (converted cart, GC'd cart, another tenant's cart)
    // reads as "no cart" — the next POST mints a fresh one.
    return NextResponse.json({ cart, requestId });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const tenant = await resolveBuyerTenant(req);
    if (!tenant) return tenantNotFound(requestId);

    const parsed = await parseBuyerBody(req, upsertPayloadSchema, requestId);
    if (!parsed.ok) return parsed.response;

    const ctx = { tenantId: tenant.tenantId, requestId };
    const { cartId } = await getOrCreateCart(ctx, readCartIdFrom(req));
    const cart = await upsertLine(ctx, cartId, parsed.data);

    const res = NextResponse.json({ cart, requestId });
    // Set on every write, not only on create: activity extends the
    // cookie's 30-day window in step with carts.updated_at.
    setCartCookie(res, cartId);
    return res;
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
