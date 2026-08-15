import { createHash, randomUUID } from "node:crypto";

import { AppError, safeEqual } from "@platform/core";

import { parseRazorpayShapedWebhook, webhookSignature } from "./razorpay";
import type { PaymentGatewayAdapter } from "./types";

/**
 * The dev/CI gateway: in-process synthetic ids, no network, plus the
 * `mockWebhookBody` fabricator/signer so tests and the console's
 * send-test-event button (D19) drive the REAL storefront webhook route
 * with a correctly-HMAC'd payload.
 *
 * FAIL-CLOSED GATE (fake-carrier precedent, hardened): every entry point
 * refuses when NODE_ENV is 'production' OR unset. The check is written
 * as a refusal of the dangerous states, never as "enable when
 * development" — both Next apps build/start with NODE_ENV=production and
 * vitest sets 'test', so the only way to reach this driver is to be
 * explicitly in a non-production environment.
 */
export function assertMockGatewayAllowed(): void {
  const env = process.env.NODE_ENV;
  if (!env || env === "production") {
    throw new AppError({
      code: "mock_gateway_forbidden",
      message: `Mock payment gateway refused: NODE_ENV is ${env ? `'${env}'` : "unset"}`,
      status: 403,
      publicMessage: "The mock payment gateway is not available in this environment.",
    });
  }
}

/**
 * Deterministic synthetic id: the same seed always mints the same id, so
 * a retried createGatewayOrder / refund behaves like a gateway that
 * deduplicated the request (the fake carrier's idempotency map, without
 * the state).
 */
function syntheticId(prefix: string, seed: string): string {
  return `${prefix}${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 20)}`;
}

export const mock: PaymentGatewayAdapter = {
  provider: "mock",

  async createGatewayOrder(_creds, args) {
    assertMockGatewayAllowed();
    return {
      gatewayOrderId: syntheticId(
        "order_mock_",
        `${args.receipt}:${args.amountPaise}:${args.currency}`,
      ),
    };
  },

  /** Same scheme as the real driver: HMAC-SHA256 hex over the RAW body. */
  verifyWebhook(webhookSecret, { rawBody, signature }) {
    assertMockGatewayAllowed();
    if (!webhookSecret || !signature) return false;
    return safeEqual(webhookSignature(webhookSecret, rawBody), signature);
  },

  parseWebhook(rawBody) {
    assertMockGatewayAllowed();
    return parseRazorpayShapedWebhook(rawBody);
  },

  async refund(_creds, args) {
    assertMockGatewayAllowed();
    return { gatewayRefundId: syntheticId("rfnd_mock_", args.idempotencyKey) };
  },
};

export type MockWebhookArgs = {
  type?: "payment.captured" | "payment.failed" | "refund.processed";
  /** Defaults to a fresh evt_mock_… uuid — THE idempotency key. */
  eventId?: string;
  gatewayOrderId: string;
  gatewayPaymentId?: string;
  gatewayRefundId?: string;
  amountPaise: number;
  method?: string;
  /** Settlement economics (D17); omitted = the gateway reported none. */
  feePaise?: number;
  feeTaxPaise?: number;
  errorCode?: string;
  errorDescription?: string;
};

/**
 * Fabricates a Razorpay-shaped webhook body and signs it with the SAME
 * HMAC scheme the verifier checks, so the payload survives the real
 * route's verification. Unlike the real gateway, the event id is written
 * INTO the body (`id`) as well as returned — callers should still send
 * it as x-razorpay-event-id so the route sees one header contract for
 * both providers.
 */
export function mockWebhookBody(
  webhookSecret: string,
  args: MockWebhookArgs,
): { rawBody: string; signature: string; eventId: string } {
  assertMockGatewayAllowed();

  const type = args.type ?? "payment.captured";
  const eventId = args.eventId ?? `evt_mock_${randomUUID()}`;
  const paymentId = args.gatewayPaymentId ?? syntheticId("pay_mock_", eventId);

  const paymentEntity = {
    id: paymentId,
    entity: "payment",
    amount: args.amountPaise,
    currency: "INR",
    status: type === "payment.failed" ? "failed" : "captured",
    order_id: args.gatewayOrderId,
    method: args.method ?? "upi",
    fee: args.feePaise ?? null,
    tax: args.feeTaxPaise ?? null,
    error_code: args.errorCode ?? null,
    error_description: args.errorDescription ?? null,
  };

  const payload =
    type === "refund.processed"
      ? {
          refund: {
            entity: {
              id: args.gatewayRefundId ?? syntheticId("rfnd_mock_", eventId),
              entity: "refund",
              amount: args.amountPaise,
              currency: "INR",
              payment_id: paymentId,
              status: "processed",
            },
          },
          payment: { entity: paymentEntity },
        }
      : { payment: { entity: paymentEntity } };

  const rawBody = JSON.stringify({
    id: eventId,
    entity: "event",
    event: type,
    contains: Object.keys(payload),
    payload,
    created_at: Math.floor(Date.now() / 1000),
  });

  return { rawBody, signature: webhookSignature(webhookSecret, rawBody), eventId };
}
