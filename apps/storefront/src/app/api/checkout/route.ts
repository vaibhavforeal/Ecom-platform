import { NextResponse } from "next/server";

import { AppError } from "@platform/core";
import { checkoutPayloadSchema } from "@platform/core/checkout";
import { setGatewayAdapterResolver, startCheckout } from "@platform/core/checkout/server";
import { getPaymentAdapter } from "@platform/integrations/payments";

import {
  errorResponse,
  newRequestId,
  parseBuyerBody,
  resolveBuyerTenant,
  tenantNotFound,
} from "../../../lib/buyer-api";
import { readCartIdFrom } from "../../../lib/cart-cookie";

/**
 * POST /api/checkout (spec §4.2, §7) — the checkout-start door.
 *
 * Tenant from the Host, cart identity from the httpOnly cookie, and the
 * S0-frozen CheckoutPayload as the single zod parse. The domain
 * orchestration (idempotency, holds, totals, COD confirm, gateway
 * hand-off) lives in @platform/core/checkout/server; this file is
 * transport only.
 */

export const dynamic = "force-dynamic";
// The domain layer reaches PostgreSQL through the postgres driver, which
// the edge runtime has no sockets for.
export const runtime = "nodejs";

// core cannot import @platform/integrations (it would be a package
// cycle), so the gateway registry is injected here, at the one place the
// checkout flow enters from the web (design D4's synchronous
// createGatewayOrder).
setGatewayAdapterResolver(getPaymentAdapter);

export async function POST(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const tenant = await resolveBuyerTenant(req);
    if (!tenant) return tenantNotFound(requestId);

    const parsed = await parseBuyerBody(req, checkoutPayloadSchema, requestId);
    if (!parsed.ok) return parsed.response;

    const cartId = readCartIdFrom(req);
    if (!cartId) {
      throw new AppError({
        code: "not_found",
        message: "Checkout POST without a cart cookie",
        status: 404,
        publicMessage: "Your cart could not be found. Add something to it first.",
      });
    }

    const result = await startCheckout({ tenantId: tenant.tenantId, requestId }, cartId, parsed.data);
    return NextResponse.json({ ...result, requestId });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
