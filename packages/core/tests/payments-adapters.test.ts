import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../src/errors";
import { computeAdvanceSplit } from "../src/payments/index";
import { mock, mockWebhookBody } from "../../integrations/src/payments/mock";
import { razorpay } from "../../integrations/src/payments/razorpay";
import {
  availablePaymentProviders,
  getPaymentAdapter,
} from "../../integrations/src/payments/registry";

/**
 * Payment drivers + registry + the §6.2 advance split. No DB, no
 * network — the razorpay driver's HTTP methods are not exercised here
 * (they run from the worker / checkout against the live API); what IS
 * pinned is everything that guards money: the HMAC verification, the
 * webhook parse (fee economics, D17), the registry's fail-closed gate,
 * and the paise arithmetic.
 */

const CREDS = { keyId: "rzp_test_key", keySecret: "rzp_test_secret" };

// ───────────────────────────────────────────────────────────────
// Registry — the real-vs-mock gate FAILS CLOSED (unset OR production)
// ───────────────────────────────────────────────────────────────
describe("getPaymentAdapter gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the razorpay driver, tagged with its provider code", () => {
    const adapter = getPaymentAdapter("razorpay");
    expect(adapter.provider).toBe("razorpay");
  });

  it("returns the mock driver under an explicit non-production NODE_ENV", () => {
    // vitest sets NODE_ENV=test — exactly the environment mock is for.
    expect(getPaymentAdapter("mock").provider).toBe("mock");
  });

  it("refuses the mock driver when NODE_ENV is unset (fail closed, never fail open)", () => {
    vi.stubEnv("NODE_ENV", undefined);
    expect(() => getPaymentAdapter("mock")).toThrowError(AppError);
    try {
      getPaymentAdapter("mock");
    } catch (err) {
      expect((err as AppError).code).toBe("mock_gateway_forbidden");
    }
  });

  it("refuses the mock driver when NODE_ENV is production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => getPaymentAdapter("mock")).toThrowError(AppError);
    // The razorpay driver stays available — the gate is mock-only.
    expect(getPaymentAdapter("razorpay").provider).toBe("razorpay");
  });

  it("lists mock as connectable only outside production with NODE_ENV set", () => {
    expect(availablePaymentProviders()).toContain("mock");
    vi.stubEnv("NODE_ENV", "production");
    expect(availablePaymentProviders()).toEqual(["razorpay"]);
    vi.stubEnv("NODE_ENV", undefined);
    expect(availablePaymentProviders()).toEqual(["razorpay"]);
  });

  it("mock driver methods refuse in production even when the registry is bypassed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      mock.createGatewayOrder(CREDS, { amountPaise: 100, currency: "INR", receipt: "r1" }),
    ).rejects.toMatchObject({ code: "mock_gateway_forbidden" });
    expect(() => mock.parseWebhook("{}")).toThrowError(AppError);
    expect(() =>
      mockWebhookBody("whsec", { gatewayOrderId: "order_x", amountPaise: 100 }),
    ).toThrowError(AppError);
  });
});

// ───────────────────────────────────────────────────────────────
// Razorpay HMAC verification — known vector + tamper
// ───────────────────────────────────────────────────────────────

/**
 * Known vector, precomputed once with node:crypto and PINNED:
 * HMAC-SHA256(body, "rzp_whsec_known_vector") in hex. If this test ever
 * fails, the verifier changed — not the vector.
 */
const VECTOR_SECRET = "rzp_whsec_known_vector";
const VECTOR_BODY =
  '{"entity":"event","event":"payment.captured","payload":{"payment":{"entity":' +
  '{"id":"pay_KnownVector001","amount":129900,"currency":"INR","status":"captured",' +
  '"order_id":"order_KnownVector001","method":"upi","fee":2598,"tax":396,' +
  '"error_code":null,"error_description":null}}},"created_at":1755000000}';
const VECTOR_SIGNATURE = "9147e29b5e93f9731a8c14f1d42eab243b3274df9716e8ac69a1a42a52cc44be";

describe("razorpay.verifyWebhook", () => {
  it("accepts the pinned known vector", () => {
    // The vector is honest: recompute it here so a typo in the constant
    // cannot silently pass.
    expect(
      createHmac("sha256", VECTOR_SECRET).update(VECTOR_BODY, "utf8").digest("hex"),
    ).toBe(VECTOR_SIGNATURE);
    expect(
      razorpay.verifyWebhook(VECTOR_SECRET, { rawBody: VECTOR_BODY, signature: VECTOR_SIGNATURE }),
    ).toBe(true);
  });

  it("rejects a tampered body — one flipped digit in the amount", () => {
    const tampered = VECTOR_BODY.replace('"amount":129900', '"amount":129901');
    expect(
      razorpay.verifyWebhook(VECTOR_SECRET, { rawBody: tampered, signature: VECTOR_SIGNATURE }),
    ).toBe(false);
  });

  it("rejects the right signature under the wrong secret", () => {
    expect(
      razorpay.verifyWebhook("rzp_whsec_other", {
        rawBody: VECTOR_BODY,
        signature: VECTOR_SIGNATURE,
      }),
    ).toBe(false);
  });

  it("returns false (never throws) for empty or wrong-length signatures", () => {
    expect(razorpay.verifyWebhook(VECTOR_SECRET, { rawBody: VECTOR_BODY, signature: "" })).toBe(
      false,
    );
    expect(
      razorpay.verifyWebhook(VECTOR_SECRET, { rawBody: VECTOR_BODY, signature: "deadbeef" }),
    ).toBe(false);
    expect(razorpay.verifyWebhook("", { rawBody: VECTOR_BODY, signature: VECTOR_SIGNATURE })).toBe(
      false,
    );
  });
});

// ───────────────────────────────────────────────────────────────
// Razorpay parseWebhook — shapes, fee economics (D17), event ids
// ───────────────────────────────────────────────────────────────
describe("razorpay.parseWebhook", () => {
  it("extracts a payment.captured event including fee_paise/fee_tax_paise (D17)", () => {
    const event = razorpay.parseWebhook(VECTOR_BODY);
    expect(event.type).toBe("payment.captured");
    expect(event.gatewayOrderId).toBe("order_KnownVector001");
    expect(event.gatewayPaymentId).toBe("pay_KnownVector001");
    expect(event.amountPaise).toBe(129900);
    expect(event.method).toBe("upi");
    expect(event.feePaise).toBe(2598);
    expect(event.feeTaxPaise).toBe(396);
    expect(event.error).toBeUndefined();
  });

  it("leaves fee fields undefined when the gateway reported none", () => {
    const body = JSON.stringify({
      entity: "event",
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: "pay_nofee", amount: 5000, order_id: "order_nofee", method: "card" },
        },
      },
    });
    const event = razorpay.parseWebhook(body);
    expect(event.feePaise).toBeUndefined();
    expect(event.feeTaxPaise).toBeUndefined();
  });

  it("extracts a payment.failed event with the error pair", () => {
    const body = JSON.stringify({
      entity: "event",
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_failed01",
            amount: 5000,
            order_id: "order_failed01",
            method: "upi",
            error_code: "BAD_REQUEST_ERROR",
            error_description: "Payment failed at the bank",
          },
        },
      },
    });
    const event = razorpay.parseWebhook(body);
    expect(event.type).toBe("payment.failed");
    expect(event.error).toEqual({
      code: "BAD_REQUEST_ERROR",
      description: "Payment failed at the bank",
    });
  });

  it("extracts a refund.processed event: refund id, refund amount, payment id", () => {
    const body = JSON.stringify({
      entity: "event",
      event: "refund.processed",
      payload: {
        refund: { entity: { id: "rfnd_proc01", amount: 129900, payment_id: "pay_KnownVector001" } },
        payment: {
          entity: { id: "pay_KnownVector001", amount: 129900, order_id: "order_KnownVector001" },
        },
      },
    });
    const event = razorpay.parseWebhook(body);
    expect(event.type).toBe("refund.processed");
    expect(event.gatewayRefundId).toBe("rfnd_proc01");
    expect(event.gatewayPaymentId).toBe("pay_KnownVector001");
    expect(event.gatewayOrderId).toBe("order_KnownVector001");
    expect(event.amountPaise).toBe(129900);
  });

  it("derives a deterministic body-digest eventId when the body carries none, and prefers an explicit id", () => {
    // Razorpay's event id travels only in a header; redeliveries repeat
    // the body byte for byte, so the digest must be stable.
    const first = razorpay.parseWebhook(VECTOR_BODY);
    const second = razorpay.parseWebhook(VECTOR_BODY);
    expect(first.eventId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.eventId).toBe(first.eventId);

    const withId = razorpay.parseWebhook(
      JSON.stringify({ id: "evt_explicit01", event: "payment.captured", payload: {} }),
    );
    expect(withId.eventId).toBe("evt_explicit01");
  });

  it("throws a typed 400 on a non-JSON body", () => {
    expect(() => razorpay.parseWebhook("not json {")).toThrowError(AppError);
    try {
      razorpay.parseWebhook("not json {");
    } catch (err) {
      expect((err as AppError).code).toBe("invalid_webhook_payload");
      expect((err as AppError).status).toBe(400);
    }
  });
});

// ───────────────────────────────────────────────────────────────
// Mock driver — determinism + fabricator/signer roundtrip
// ───────────────────────────────────────────────────────────────
describe("mock driver", () => {
  it("mints deterministic gateway order ids: same receipt+amount → same id", async () => {
    const a = await mock.createGatewayOrder(CREDS, {
      amountPaise: 129900,
      currency: "INR",
      receipt: "order-r1",
    });
    const b = await mock.createGatewayOrder(CREDS, {
      amountPaise: 129900,
      currency: "INR",
      receipt: "order-r1",
    });
    const c = await mock.createGatewayOrder(CREDS, {
      amountPaise: 129900,
      currency: "INR",
      receipt: "order-r2",
    });
    expect(a.gatewayOrderId).toBe(b.gatewayOrderId);
    expect(a.gatewayOrderId).toMatch(/^order_mock_[0-9a-f]{20}$/);
    expect(c.gatewayOrderId).not.toBe(a.gatewayOrderId);
  });

  it("mints deterministic refund ids from the idempotency key", async () => {
    const a = await mock.refund(CREDS, {
      gatewayPaymentId: "pay_mock_x",
      amountPaise: 100,
      idempotencyKey: "refund-1",
    });
    const b = await mock.refund(CREDS, {
      gatewayPaymentId: "pay_mock_x",
      amountPaise: 100,
      idempotencyKey: "refund-1",
    });
    expect(a.gatewayRefundId).toBe(b.gatewayRefundId);
    expect(a.gatewayRefundId).toMatch(/^rfnd_mock_[0-9a-f]{20}$/);
  });

  it("mockWebhookBody signs so the driver's own verifier accepts, and tampering breaks it", () => {
    const { rawBody, signature } = mockWebhookBody("whsec_mock_1", {
      gatewayOrderId: "order_mock_t1",
      amountPaise: 4200,
    });
    expect(mock.verifyWebhook("whsec_mock_1", { rawBody, signature })).toBe(true);
    expect(mock.verifyWebhook("whsec_mock_1", { rawBody: rawBody + " ", signature })).toBe(false);
    expect(mock.verifyWebhook("whsec_other", { rawBody, signature })).toBe(false);
  });

  it("fabricated bodies roundtrip through parseWebhook with the event id and fee fields intact", () => {
    const { rawBody, eventId } = mockWebhookBody("whsec_mock_1", {
      type: "payment.captured",
      eventId: "evt_mock_fixed01",
      gatewayOrderId: "order_mock_t2",
      gatewayPaymentId: "pay_mock_t2",
      amountPaise: 129900,
      method: "upi",
      feePaise: 2598,
      feeTaxPaise: 396,
    });
    expect(eventId).toBe("evt_mock_fixed01");
    const event = mock.parseWebhook(rawBody);
    expect(event.eventId).toBe("evt_mock_fixed01");
    expect(event.type).toBe("payment.captured");
    expect(event.gatewayOrderId).toBe("order_mock_t2");
    expect(event.gatewayPaymentId).toBe("pay_mock_t2");
    expect(event.amountPaise).toBe(129900);
    expect(event.feePaise).toBe(2598);
    expect(event.feeTaxPaise).toBe(396);
  });

  it("fabricates refund.processed bodies carrying the refund id", () => {
    const { rawBody } = mockWebhookBody("whsec_mock_1", {
      type: "refund.processed",
      eventId: "evt_mock_refund01",
      gatewayOrderId: "order_mock_t3",
      gatewayPaymentId: "pay_mock_t3",
      gatewayRefundId: "rfnd_mock_t3",
      amountPaise: 5000,
    });
    const event = mock.parseWebhook(rawBody);
    expect(event.type).toBe("refund.processed");
    expect(event.gatewayRefundId).toBe("rfnd_mock_t3");
    expect(event.gatewayPaymentId).toBe("pay_mock_t3");
    expect(event.amountPaise).toBe(5000);
  });
});

// ───────────────────────────────────────────────────────────────
// computeAdvanceSplit (§6.2) — B3 owns the function; the checklist
// boxes are pinned here because no other lot owns a partial-payment file
// ───────────────────────────────────────────────────────────────
describe("computeAdvanceSplit", () => {
  const policy = { codEnabled: true, advanceBps: 2000, minAdvancePaise: 5000 };

  it("prepaid: the whole total moves in advance", () => {
    expect(computeAdvanceSplit(129900, policy, "prepaid")).toEqual({
      advancePaise: 129900,
      codDuePaise: 0,
    });
  });

  it("cod: advance 0, the whole total due at the door", () => {
    expect(computeAdvanceSplit(129900, policy, "cod")).toEqual({
      advancePaise: 0,
      codDuePaise: 129900,
    });
  });

  it("cod disabled refuses BOTH cod and cod_advance with a 422 invalid_payload", () => {
    const disabled = { ...policy, codEnabled: false };
    for (const mode of ["cod", "cod_advance"] as const) {
      try {
        computeAdvanceSplit(129900, disabled, mode);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("invalid_payload");
        expect((err as AppError).status).toBe(422);
      }
    }
  });

  it("cod_advance with advanceBps null refuses with advance_not_configured", () => {
    try {
      computeAdvanceSplit(129900, { ...policy, advanceBps: null }, "cod_advance");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AppError).code).toBe("advance_not_configured");
      expect((err as AppError).status).toBe(422);
    }
  });

  it("rounds the advance HALF_UP from bps", () => {
    // 12345 × 2000 / 10000 = 2469.0 exactly.
    expect(computeAdvanceSplit(12345, { ...policy, minAdvancePaise: 0 }, "cod_advance")).toEqual({
      advancePaise: 2469,
      codDuePaise: 9876,
    });
    // 999 × 2500 / 10000 = 249.75 → 250.
    expect(
      computeAdvanceSplit(999, { codEnabled: true, advanceBps: 2500, minAdvancePaise: 0 }, "cod_advance"),
    ).toEqual({ advancePaise: 250, codDuePaise: 749 });
    // 1000 × 25 / 10000 = 2.5 → HALF_UP → 3, never banker's 2.
    expect(
      computeAdvanceSplit(1000, { codEnabled: true, advanceBps: 25, minAdvancePaise: 0 }, "cod_advance"),
    ).toEqual({ advancePaise: 3, codDuePaise: 997 });
  });

  it("clamps the advance up to the floor and down to the total", () => {
    // Raw 20% of 10000 = 2000, floor 5000 wins.
    expect(computeAdvanceSplit(10000, policy, "cod_advance")).toEqual({
      advancePaise: 5000,
      codDuePaise: 5000,
    });
    // minAdvance > total → advance = total (effectively prepaid).
    expect(computeAdvanceSplit(3000, policy, "cod_advance")).toEqual({
      advancePaise: 3000,
      codDuePaise: 0,
    });
  });

  it("zero-total orders split 0/0 in every mode (gateway skipped)", () => {
    expect(computeAdvanceSplit(0, policy, "prepaid")).toEqual({ advancePaise: 0, codDuePaise: 0 });
    expect(computeAdvanceSplit(0, policy, "cod")).toEqual({ advancePaise: 0, codDuePaise: 0 });
    expect(computeAdvanceSplit(0, policy, "cod_advance")).toEqual({
      advancePaise: 0,
      codDuePaise: 0,
    });
  });

  it("advance + codDue === total EXACTLY across a sweep of awkward totals", () => {
    for (const total of [1, 2, 3, 99, 101, 4999, 5001, 12345, 99999, 100001, 987654321]) {
      for (const mode of ["prepaid", "cod", "cod_advance"] as const) {
        const { advancePaise, codDuePaise } = computeAdvanceSplit(total, policy, mode);
        expect(advancePaise + codDuePaise).toBe(total);
        expect(Number.isSafeInteger(advancePaise)).toBe(true);
        expect(advancePaise).toBeGreaterThanOrEqual(0);
        expect(codDuePaise).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("refuses non-integer and negative totals", () => {
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => computeAdvanceSplit(bad, policy, "prepaid")).toThrowError(AppError);
    }
  });
});
