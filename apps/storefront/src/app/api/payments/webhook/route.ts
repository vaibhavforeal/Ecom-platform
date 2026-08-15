import { NextResponse } from "next/server";

import { confirmFromWebhookEvent } from "@platform/core/checkout/server";
import {
  getEnabledAccount,
  recordWebhookEvent,
  unsealWebhookSecret,
} from "@platform/core/payments/server";
import { getPaymentAdapter } from "@platform/integrations/payments";
import { and, eq, orders, withTenant } from "@platform/db";

import {
  errorResponse,
  newRequestId,
  resolveBuyerTenant,
  tenantNotFound,
} from "../../../../lib/buyer-api";

/**
 * The webhook door (spec §4.4). Order of operations is the contract:
 *
 *  1. Tenant from the Host (each merchant registers
 *     https://{their-domain}/api/payments/webhook — no tenant id in any
 *     URL or payload). Bounded RAW body read (256 KiB).
 *  2. HMAC verification against the RAW body BEFORE any body use,
 *     unsealing ONLY the webhook-secret blob (D7). Invalid → 401,
 *     nothing stored.
 *  3. [TX-1] evidence row (recordWebhookEvent) commits in its own tx;
 *     a duplicate gateway event id means the evidence already exists —
 *     processing re-runs idempotently either way.
 *  4. Processing (confirmFromWebhookEvent). 2xx ONLY after it commits;
 *     a throw becomes a non-2xx and rides gateway redelivery (D15).
 *
 * The gateway event id prefers the x-razorpay-event-id HEADER (Razorpay
 * carries it only there); the mock driver also writes it into the body,
 * which parseWebhook surfaces as the fallback.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Razorpay webhook payloads are small; anything near this is not one. */
const MAX_WEBHOOK_BYTES = 256 * 1024;

/** Bounded raw-body read, counted off the socket. null = over the bound. */
async function readRawBody(req: Request): Promise<string | null> {
  const body = req.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function unauthorized(requestId: string, message: string): NextResponse {
  return NextResponse.json(
    { error: { code: "invalid_signature", message }, requestId },
    { status: 401 },
  );
}

export async function POST(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const tenant = await resolveBuyerTenant(req);
    if (!tenant) return tenantNotFound(requestId);
    const ctx = { tenantId: tenant.tenantId, requestId };

    const rawBody = await readRawBody(req);
    if (rawBody === null) {
      return NextResponse.json(
        {
          error: { code: "payload_too_large", message: "Webhook bodies must be 256 KiB or smaller." },
          requestId,
        },
        { status: 413 },
      );
    }

    // The enabled gateway account — without one, no webhook can be
    // authenticated, and an unauthenticated webhook learns nothing.
    const account = await withTenant(ctx.tenantId, (tx) => getEnabledAccount(tx, ctx.tenantId));
    if (!account) return unauthorized(requestId, "No enabled payment gateway.");

    // ONLY the HMAC secret is unsealed on this path (D7) — never the API
    // keys. Verification runs BEFORE the body is parsed or used.
    const webhookSecret = await unsealWebhookSecret(ctx.tenantId, account);
    const adapter = getPaymentAdapter(account.providerCode);
    const signature = req.headers.get("x-razorpay-signature") ?? "";
    if (!adapter.verifyWebhook(webhookSecret, { rawBody, signature })) {
      return unauthorized(requestId, "Webhook signature verification failed.");
    }

    // Verified — NOW the body may be read into domain shapes.
    const parsed = adapter.parseWebhook(rawBody);
    // Prefer the header for the event id (Razorpay's real carrier); the
    // parsed body id / body digest is the mock-and-fallback path.
    const eventId = req.headers.get("x-razorpay-event-id") ?? parsed.eventId;
    const event = { ...parsed, eventId };

    // Resolve the subject order for the evidence row (nullable — test
    // events and foreign refs record with no order).
    const orderId = event.gatewayOrderId
      ? await withTenant(ctx.tenantId, async (tx) => {
          const [row] = await tx
            .select({ id: orders.id })
            .from(orders)
            .where(
              and(eq(orders.tenantId, ctx.tenantId), eq(orders.gatewayOrderRef, event.gatewayOrderId)),
            )
            .limit(1);
          return row?.id ?? null;
        })
      : null;

    // [TX-1] — the evidence row, committed before processing. The unique
    // constraint on the gateway event id IS the dedupe; duplicate=true
    // short-circuits into the same idempotent processing.
    const { webhookEventId } = await recordWebhookEvent(ctx, {
      providerCode: account.providerCode,
      gatewayEventId: eventId,
      eventType: event.type,
      orderId,
      rawPayload: JSON.parse(rawBody) as unknown,
    });

    // [TX-2/TX-3] — idempotent processing. 2xx only after this resolves;
    // a throw surfaces as non-2xx and the gateway redelivers.
    await confirmFromWebhookEvent(ctx, { webhookEventId, event });

    return NextResponse.json({ received: true, requestId });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
