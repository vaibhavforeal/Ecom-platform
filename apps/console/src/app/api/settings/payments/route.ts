import { NextResponse } from "next/server";

import { assertCan, primaryHostname } from "@platform/core";
import { getPaymentAccountView, upsertPaymentAccount } from "@platform/core/payments/server";
import { assertMockGatewayAllowed } from "@platform/integrations/payments";
import { PAYMENT_PROVIDER_CODES } from "@platform/db";
import { z } from "zod";

import { errorResponse, newRequestId } from "../../../../lib/api";
import { handleCatalogWrite } from "../../../../lib/catalog-routes";
import { getActorOrThrow } from "../../../../lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Gateway credentials (BYOG). Two secrets travel IN on PUT and are
 * sealed into two separate envelope blobs (D7); neither ever travels
 * OUT — GET returns a fingerprint and the copyable webhook URL only.
 */

const paymentSettingsSchema = z.object({
  providerCode: z.enum(PAYMENT_PROVIDER_CODES),
  label: z.string().trim().min(1).max(80).optional(),
  publicKeyId: z.string().trim().min(1).max(200),
  keySecret: z.string().min(1).max(500),
  webhookSecret: z.string().min(1).max(500),
  isEnabled: z.boolean(),
});

/** Where the merchant registers their webhook at the gateway dashboard. */
async function webhookUrlFor(tenantId: string): Promise<string | null> {
  const host = await primaryHostname(tenantId);
  return host ? `https://${host}/api/payments/webhook` : null;
}

export async function GET(): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const actor = await getActorOrThrow();
    assertCan(actor, "payments:write");

    const account = await getPaymentAccountView(actor.tenantId);
    return NextResponse.json({
      account,
      webhookUrl: await webhookUrlFor(actor.tenantId),
      requestId,
    });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}

export async function PUT(req: Request): Promise<NextResponse> {
  return handleCatalogWrite(
    req,
    paymentSettingsSchema,
    async (ctx, payload) => {
      // The registry's fail-closed rule, applied at write time too: a
      // production console (or one with NODE_ENV unset) may not even
      // STORE a mock-gateway account.
      if (payload.providerCode === "mock") assertMockGatewayAllowed();

      const account = await upsertPaymentAccount(ctx, payload);
      return { account, webhookUrl: await webhookUrlFor(ctx.tenantId) };
    },
    { permission: "payments:write" },
  );
}
