import { randomUUID } from "node:crypto";

import type { NextResponse } from "next/server";

import { AppError, primaryHostname } from "@platform/core";
import type { WriteContext } from "@platform/core/catalog/server";
import { getEnabledAccount, unsealWebhookSecret } from "@platform/core/payments/server";
import { getPaymentAdapter, mockWebhookBody } from "@platform/integrations/payments";
import { withTenant } from "@platform/db";
import { z } from "zod";

import { handleCatalogWrite } from "../../../../../lib/catalog-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Send-test-event (D19): fabricates a correctly-HMAC'd payment.captured
 * webhook with the mock driver and POSTs it at the REAL storefront
 * webhook route, end to end — signature verification, the evidence row,
 * the idempotency constraint, all of it. Mock-provider accounts only;
 * real gateways send their own test events from their dashboards.
 *
 * The POST goes to the storefront origin from env exactly like the
 * cache-purge client does, with the tenant's primary hostname as
 * x-forwarded-host so the route resolves the tenant the same way a real
 * gateway delivery would: by Host, never by anything in the payload.
 */

const TEST_EVENT_TIMEOUT_MS = 5_000;

/** POST body is `{}` (or empty) — nothing configurable travels in. */
const emptySchema = z.object({}).nullish();

async function sendTestEvent(ctx: WriteContext): Promise<{
  delivered: boolean;
  storefrontStatus: number;
  eventId: string;
  webhookUrl: string;
}> {
  const account = await withTenant(ctx.tenantId, (tx) => getEnabledAccount(tx, ctx.tenantId));
  if (!account) {
    throw new AppError({
      code: "no_enabled_gateway",
      message: "No enabled payment account to test",
      status: 422,
      publicMessage: "Save and enable a payment gateway before sending a test event.",
    });
  }
  if (account.providerCode !== "mock") {
    throw new AppError({
      code: "test_event_unsupported",
      message: `Test events are mock-only; enabled provider is ${account.providerCode}`,
      status: 422,
      publicMessage:
        "Test events are only available for the mock provider. Real gateways send test webhooks from their own dashboard.",
    });
  }

  // The fail-closed gate: refuses in production and on unset NODE_ENV.
  getPaymentAdapter("mock");

  // ONLY the webhook blob is unsealed here (D7) — signing a webhook needs
  // the HMAC secret and nothing else; the API keys stay sealed.
  const webhookSecret = await unsealWebhookSecret(ctx.tenantId, account);

  const origin = process.env.STOREFRONT_INTERNAL_ORIGIN;
  if (!origin) {
    throw new AppError({
      code: "storefront_not_configured",
      message: "STOREFRONT_INTERNAL_ORIGIN is not set",
      status: 503,
      publicMessage: "The storefront origin is not configured on this deployment.",
    });
  }
  const host = await primaryHostname(ctx.tenantId);
  if (!host) {
    throw new AppError({
      code: "no_verified_domain",
      message: "Tenant has no verified domain to address the webhook route by",
      status: 422,
      publicMessage: "Verify a domain first — webhooks reach your store by its hostname.",
    });
  }

  const eventId = `evt_mock_test_${randomUUID()}`;
  const { rawBody, signature } = mockWebhookBody(webhookSecret, {
    type: "payment.captured",
    eventId,
    gatewayOrderId: `order_mock_test_${randomUUID()}`,
    gatewayPaymentId: `pay_mock_test_${randomUUID()}`,
    amountPaise: 100,
    method: "upi",
    feePaise: 2,
    feeTaxPaise: 0,
  });

  let response: Response;
  try {
    response = await fetch(new URL("/api/payments/webhook", origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": signature,
        "x-razorpay-event-id": eventId,
        "x-forwarded-host": host,
      },
      body: rawBody,
      signal: AbortSignal.timeout(TEST_EVENT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AppError({
      code: "test_event_failed",
      message: `Test webhook POST failed: ${String(err)}`,
      status: 502,
      publicMessage: "The storefront webhook endpoint could not be reached.",
    });
  }

  return {
    delivered: response.ok,
    storefrontStatus: response.status,
    eventId,
    webhookUrl: `https://${host}/api/payments/webhook`,
  };
}

export async function POST(req: Request): Promise<NextResponse> {
  return handleCatalogWrite(req, emptySchema, (ctx) => sendTestEvent(ctx), {
    permission: "payments:write",
  });
}
