import { NextResponse } from "next/server";

import { PINCODE_RE } from "@platform/core/serviceability";
import { checkServiceability } from "@platform/core/serviceability/server";
import { z } from "zod";

import {
  errorResponse,
  newRequestId,
  parseBuyerBody,
  resolveBuyerTenant,
  tenantNotFound,
} from "../../../../lib/buyer-api";

/**
 * Pincode precheck widget (spec §7): POST {pincode} → does the store's
 * shipping.pincode_policy serve it? Uncached — a merchant tightening the
 * policy must take effect on the next keystroke, not after a TTL.
 *
 * 'carrier' policy mode surfaces as a 422 `not_supported_yet` envelope
 * (no live carrier transport in Phase 2 — see serviceability/server).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const serviceabilityPayloadSchema = z.object({
  pincode: z.string().regex(PINCODE_RE, { message: "Enter a valid 6-digit pincode." }),
});

export async function POST(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const tenant = await resolveBuyerTenant(req);
    if (!tenant) return tenantNotFound(requestId);

    const parsed = await parseBuyerBody(req, serviceabilityPayloadSchema, requestId);
    if (!parsed.ok) return parsed.response;

    // The precheck widget runs before a payment mode is chosen; the
    // Phase 2 policy ignores the mode, so a neutral one is passed.
    const result = await checkServiceability(
      { tenantId: tenant.tenantId, requestId },
      { pincode: parsed.data.pincode, paymentMode: "prepaid" },
    );

    return NextResponse.json({ ...result, requestId });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
