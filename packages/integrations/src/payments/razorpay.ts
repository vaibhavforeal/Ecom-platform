import { createHash, createHmac } from "node:crypto";

import { AppError, safeEqual } from "@platform/core";
import { z } from "zod";

import type { GatewayCredentials, GatewayEvent, PaymentGatewayAdapter } from "./types";

/**
 * The real BYOG driver: Razorpay's Orders + Refunds APIs over plain
 * fetch, HMAC-SHA256 webhook verification with a constant-time compare.
 * Credentials arrive per call (unsealed by the caller from the tenant's
 * envelope) and are never stored, logged or echoed here.
 */

const API_BASE = "https://api.razorpay.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;

/** HMAC-SHA256 hex over the RAW body — Razorpay's webhook signature scheme. */
export function webhookSignature(webhookSecret: string, rawBody: string): string {
  return createHmac("sha256", webhookSecret).update(rawBody, "utf8").digest("hex");
}

function basicAuth(creds: GatewayCredentials): string {
  return "Basic " + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
}

/**
 * One POST to Razorpay. Failures become 502 AppErrors carrying the
 * gateway's response text (their error bodies are merchant-safe), never
 * the credentials.
 */
async function razorpayPost(
  creds: GatewayCredentials,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: basicAuth(creds) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AppError({
      code: "gateway_unreachable",
      message: `Razorpay ${path} unreachable: ${String(err)}`,
      status: 502,
      publicMessage: "The payment gateway could not be reached. Please try again.",
    });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new AppError({
      code: "gateway_error",
      message: `Razorpay ${path} returned ${response.status}: ${text.slice(0, 500)}`,
      status: 502,
      publicMessage: "The payment gateway refused the request.",
    });
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AppError({
      code: "gateway_error",
      message: `Razorpay ${path} returned non-JSON (${text.slice(0, 200)})`,
      status: 502,
      publicMessage: "The payment gateway returned an unreadable response.",
    });
  }
}

function requireStringId(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError({
      code: "gateway_error",
      message: `Razorpay response missing ${what}`,
      status: 502,
      publicMessage: "The payment gateway returned an unreadable response.",
    });
  }
  return value;
}

/** Razorpay webhook wire shapes — unknown keys pass through untouched. */
const paymentEntitySchema = z.object({
  id: z.string(),
  amount: z.number().int(),
  order_id: z.string().nullish(),
  method: z.string().nullish(),
  fee: z.number().int().nullish(),
  tax: z.number().int().nullish(),
  error_code: z.string().nullish(),
  error_description: z.string().nullish(),
});

const refundEntitySchema = z.object({
  id: z.string(),
  amount: z.number().int(),
  payment_id: z.string().nullish(),
});

const webhookBodySchema = z.object({
  /**
   * Razorpay carries the event id ONLY in the x-razorpay-event-id header,
   * never the body; the mock driver writes it here. Optional so both
   * parse through one schema.
   */
  id: z.string().optional(),
  event: z.string(),
  payload: z
    .object({
      payment: z.object({ entity: paymentEntitySchema }).optional(),
      refund: z.object({ entity: refundEntitySchema }).optional(),
    })
    .default({}),
});

/**
 * Normalizes a Razorpay-shaped webhook body (the mock fabricates the
 * same shape). Fee economics are extracted WHEN PRESENT (D17) —
 * `payload.payment.entity.fee` / `.tax` are the gateway fee and the GST
 * on it, both already in paise.
 *
 * eventId: the body's `id` when present (mock), else a deterministic
 * digest of the raw body — Razorpay redelivers a byte-identical body, so
 * the digest is stable across retries and the pwe unique constraint
 * still dedupes. The route should prefer the x-razorpay-event-id header
 * when it has one.
 */
export function parseRazorpayShapedWebhook(rawBody: string): GatewayEvent {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new AppError({
      code: "invalid_webhook_payload",
      message: "Webhook body is not JSON",
      status: 400,
      publicMessage: "Unreadable webhook payload.",
    });
  }
  const parsed = webhookBodySchema.safeParse(json);
  if (!parsed.success) {
    throw new AppError({
      code: "invalid_webhook_payload",
      message: `Webhook body shape not recognised: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      status: 400,
      publicMessage: "Unreadable webhook payload.",
    });
  }

  const body = parsed.data;
  const payment = body.payload.payment?.entity;
  const refund = body.payload.refund?.entity;

  const event: GatewayEvent = {
    eventId:
      body.id ?? `sha256:${createHash("sha256").update(rawBody, "utf8").digest("hex")}`,
    type: body.event,
    gatewayOrderId: payment?.order_id ?? "",
    // Refund events report the refund's amount; everything else the
    // payment's. Unknown event shapes pass through with 0.
    amountPaise: refund ? refund.amount : (payment?.amount ?? 0),
  };

  const gatewayPaymentId = payment?.id ?? refund?.payment_id;
  if (gatewayPaymentId) event.gatewayPaymentId = gatewayPaymentId;
  if (refund?.id) event.gatewayRefundId = refund.id;
  if (payment?.method) event.method = payment.method;
  if (payment?.fee !== null && payment?.fee !== undefined) event.feePaise = payment.fee;
  if (payment?.tax !== null && payment?.tax !== undefined) event.feeTaxPaise = payment.tax;
  if (payment?.error_code || payment?.error_description) {
    event.error = {};
    if (payment.error_code) event.error.code = payment.error_code;
    if (payment.error_description) event.error.description = payment.error_description;
  }
  return event;
}

export const razorpay: PaymentGatewayAdapter = {
  provider: "razorpay",

  async createGatewayOrder(creds, args) {
    const json = await razorpayPost(creds, "/orders", {
      amount: args.amountPaise,
      currency: args.currency,
      receipt: args.receipt,
    });
    return { gatewayOrderId: requireStringId(json.id, "order id") };
  },

  /**
   * HMAC-SHA256 over the RAW request body, compared in constant time.
   * Runs BEFORE any other work in the webhook route; a false here means
   * 401 and nothing stored.
   */
  verifyWebhook(webhookSecret, { rawBody, signature }) {
    if (!webhookSecret || !signature) return false;
    return safeEqual(webhookSignature(webhookSecret, rawBody), signature);
  },

  parseWebhook: parseRazorpayShapedWebhook,

  /**
   * Full-capture refund. The platform-side insert-once refunds row is
   * the real idempotency guard; the key rides to the gateway as the
   * refund's `receipt` reference so a retried call is traceable there.
   */
  async refund(creds, { gatewayPaymentId, amountPaise, idempotencyKey }) {
    const json = await razorpayPost(
      creds,
      `/payments/${encodeURIComponent(gatewayPaymentId)}/refund`,
      { amount: amountPaise, receipt: idempotencyKey },
    );
    return { gatewayRefundId: requireStringId(json.id, "refund id") };
  },
};
