import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeConnections, withTenant } from "@platform/db";
import { Queue } from "bullmq";

import { QUEUE_NAMES, closeRedis, redis, sealCredentials, credentialFingerprint } from "@platform/core";
import {
  cancelOrder,
  confirmFromWebhookEvent,
  expireCheckout,
  setGatewayAdapterResolver,
  startCheckout,
} from "@platform/core/checkout/server";
import type { CheckoutPayload } from "@platform/core/checkout";
import { recordMovement, reconcileStockLevels } from "@platform/core/inventory/server";
import { transitionOrder } from "@platform/core/orders/server";
import type { GatewayEvent, PaymentGatewayAdapter } from "@platform/core/payments";
import {
  markRefundProcessing,
  paymentCredentialsAad,
  paymentWebhookSecretAad,
  recordWebhookEvent,
} from "@platform/core/payments/server";

/**
 * Cancel + refund (spec §4.7, §4.6, D6, D9): restock through the real
 * ledger door (reconcile stays clean), the insert-once refunds UNIQUE
 * under a double-cancel, the refund job's processing mark, the
 * refund.processed webhook terminal, the shipped-state refusal, and the
 * late capture on an abandoned order.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 4, onnotice: () => {} });

let tenantA: string;
let userA: string;
let planId: string;

const savedEnv = new Map<string, string | undefined>();
let purgeServer: Server;

const fakeAdapter: PaymentGatewayAdapter = {
  provider: "mock",
  async createGatewayOrder(_creds, args) {
    return {
      gatewayOrderId:
        "order_cnl_" + createHash("sha256").update(args.receipt, "utf8").digest("hex").slice(0, 16),
    };
  },
  verifyWebhook: () => true,
  parseWebhook: () => {
    throw new Error("unused");
  },
  async refund(_creds, args) {
    return { gatewayRefundId: "rfnd_cnl_" + args.idempotencyKey.slice(0, 8) };
  },
};

function ctx() {
  return { tenantId: tenantA, requestId: "cancel-int" };
}

function writeCtx() {
  return { tenantId: tenantA, actorUserId: userA, ip: null, userAgent: null, requestId: "cancel-int" };
}

let phoneCounter = 0;
function freshPhone(): string {
  phoneCounter += 1;
  return "+9198992" + String(phoneCounter).padStart(4, "0");
}

function payload(overrides: Partial<CheckoutPayload> = {}): CheckoutPayload {
  return {
    idempotencyKey: randomUUID(),
    buyerName: "Cancel Tester",
    phone: freshPhone(),
    email: null,
    shippingAddress: {
      line1: "7 Refund Street",
      line2: null,
      city: "New Delhi",
      stateCode: "07",
      pincode: "110001",
    },
    buyerGstin: null,
    couponCode: null,
    paymentMode: "prepaid",
    ...overrides,
  };
}

async function makeVariant(): Promise<string> {
  const [product] = await admin<{ id: string }[]>`
    INSERT INTO products (id, tenant_id, title, status, hsn_code, tax_rate_bps, published_at)
    VALUES (${randomUUID()}, ${tenantA}, ${"Cancel product " + randomUUID().slice(0, 8)},
            'active', '6109', 1800, now())
    RETURNING id`;
  const [variant] = await admin<{ id: string }[]>`
    INSERT INTO product_variants
      (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory)
    VALUES (${randomUUID()}, ${tenantA}, ${product!.id}, ${"CNL-" + randomUUID().slice(0, 8)},
            49900, 100, true)
    RETURNING id`;
  return variant!.id;
}

async function seed(variantId: string, quantity: number): Promise<void> {
  await recordMovement(writeCtx(), { variantId, delta: quantity, note: "seed" });
}

async function makeCart(lines: { variantId: string; quantity: number }[]): Promise<string> {
  const [cart] = await admin<{ id: string }[]>`
    INSERT INTO carts (id, tenant_id, status) VALUES (${randomUUID()}, ${tenantA}, 'active')
    RETURNING id`;
  for (const line of lines) {
    await admin`
      INSERT INTO cart_lines (id, tenant_id, cart_id, variant_id, quantity)
      VALUES (${randomUUID()}, ${tenantA}, ${cart!.id}, ${line.variantId}, ${line.quantity})`;
  }
  return cart!.id;
}

async function orderRow(orderId: string) {
  const [row] = await admin<Record<string, unknown>[]>`SELECT * FROM orders WHERE id = ${orderId}`;
  return row!;
}

function capture(gatewayOrderId: string, amountPaise: number): GatewayEvent {
  return {
    eventId: "evt_cnl_" + randomUUID(),
    type: "payment.captured",
    gatewayOrderId,
    gatewayPaymentId: "pay_cnl_" + randomUUID().slice(0, 12),
    amountPaise,
    method: "upi",
    feePaise: 118,
    feeTaxPaise: 18,
  };
}

async function deliver(event: GatewayEvent): Promise<void> {
  const { webhookEventId } = await recordWebhookEvent(ctx(), {
    providerCode: "mock",
    gatewayEventId: event.eventId,
    eventType: event.type,
    rawPayload: {},
  });
  await confirmFromWebhookEvent(ctx(), { webhookEventId, event });
}

/** A confirmed, captured, prepaid order — the cancel tests' raw material. */
async function confirmedPrepaidOrder(
  variantId: string,
  quantity = 1,
): Promise<{ orderId: string; amountPaise: number; gatewayOrderId: string }> {
  const res = await startCheckout(ctx(), await makeCart([{ variantId, quantity }]), payload());
  if (res.status !== "payment_required") throw new Error("expected payment_required");
  await deliver(capture(res.gatewayOrderId, res.amountPaise));
  return { orderId: res.orderId, amountPaise: res.amountPaise, gatewayOrderId: res.gatewayOrderId };
}

/** A confirmed COD order (no money captured). */
async function confirmedCodOrder(variantId: string, quantity = 1): Promise<string> {
  const res = await startCheckout(
    ctx(),
    await makeCart([{ variantId, quantity }]),
    payload({ paymentMode: "cod" }),
  );
  if (res.status !== "confirmed") throw new Error("expected confirmed");
  return res.orderId;
}

beforeAll(async () => {
  for (const key of [
    "SESSION_SECRET",
    "CREDENTIALS_MASTER_KEY",
    "STOREFRONT_INTERNAL_ORIGIN",
    "INTERNAL_API_SECRET",
  ]) {
    savedEnv.set(key, process.env[key]);
  }
  process.env.SESSION_SECRET ??= "cancel-int-secret-0000000000000000000000000000000";
  process.env.CREDENTIALS_MASTER_KEY ??= randomBytes(32).toString("base64");

  purgeServer = createServer((_req, res) => {
    res.statusCode = 200;
    res.end("{}");
  });
  await new Promise<void>((resolve) => purgeServer.listen(0, "127.0.0.1", resolve));
  process.env.STOREFRONT_INTERNAL_ORIGIN = `http://127.0.0.1:${(purgeServer.address() as { port: number }).port}`;
  process.env.INTERNAL_API_SECRET = "cancel-int-internal";

  setGatewayAdapterResolver(() => fakeAdapter);

  const slug = "cnl-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"cnl-" + randomUUID().slice(0, 8)}, 'Cancel test plan')
    RETURNING id`;
  planId = plan!.id;
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants
      (id, slug, legal_name, display_name, plan_id, status,
       tax_registration_type, gstin, origin_state_code)
    VALUES (${randomUUID()}, ${slug}, 'Cancel Test Sellers Pvt Ltd', ${slug}, ${plan!.id},
            'active', 'regular', '29ABCDE1234F1Z7', '29')
    RETURNING id`;
  tenantA = tenant!.id;

  userA = randomUUID();
  const phone = "+9197" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userA}, ${phone}, 'Cancel tester')`;

  await admin`
    INSERT INTO locations (id, tenant_id, name, is_default)
    VALUES (${randomUUID()}, ${tenantA}, 'Default', true)`;

  const sealedCredentials = sealCredentials(
    { keyId: "mock_pub_cnl", keySecret: "mock_secret_cnl" },
    paymentCredentialsAad(tenantA, "mock"),
  );
  const sealedWebhookSecret = sealCredentials(
    { webhookSecret: "mock_webhook_cnl" },
    paymentWebhookSecretAad(tenantA, "mock"),
  );
  await admin`
    INSERT INTO payment_accounts
      (id, tenant_id, provider_code, label, public_key_id,
       sealed_credentials, sealed_webhook_secret, credential_fingerprint, is_enabled)
    VALUES (${randomUUID()}, ${tenantA}, 'mock', 'Default', 'mock_pub_cnl',
            ${sealedCredentials}, ${sealedWebhookSecret},
            ${credentialFingerprint(sealedCredentials)}, true)`;
});

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve) => purgeServer.close(() => resolve()));
  await admin`DELETE FROM tenants WHERE id = ${tenantA}`;
  await admin`DELETE FROM users WHERE id = ${userA}`;
  await admin`DELETE FROM plans WHERE id = ${planId}`;
  await admin.end();
  await closeRedis();
  await closeConnections();
});

describe("console cancel (§4.7)", () => {
  it("confirmed → cancelled restocks through the ledger door; reconcile stays clean", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const orderId = await confirmedCodOrder(variant, 2);
    const [before] = await admin<{ on_hand: number }[]>`
      SELECT on_hand::int FROM stock_levels WHERE tenant_id = ${tenantA} AND variant_id = ${variant}`;
    expect(before!.on_hand).toBe(3);

    await cancelOrder(writeCtx(), orderId, { reason: "customer asked" });

    const order = await orderRow(orderId);
    expect(order.status).toBe("cancelled");
    expect(order.cancel_reason).toBe("customer asked");
    expect(order.cancelled_at).not.toBeNull();

    const restocks = await admin<Record<string, unknown>[]>`
      SELECT * FROM stock_movements
      WHERE tenant_id = ${tenantA} AND reason = 'cancellation_restock'
        AND reference_type = 'order' AND reference_id = ${orderId}`;
    expect(restocks.length).toBe(1);
    expect(Number(restocks[0]!.delta)).toBe(2);

    const [after] = await admin<{ on_hand: number }[]>`
      SELECT on_hand::int FROM stock_levels WHERE tenant_id = ${tenantA} AND variant_id = ${variant}`;
    expect(after!.on_hand).toBe(5);

    // Ledger and projection agree — the restock went through the same door.
    expect(await reconcileStockLevels(tenantA)).toEqual([]);

    // COD, nothing captured → no refund intent.
    const refundRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM refunds WHERE order_id = ${orderId}`;
    expect(refundRows[0]!.n).toBe(0);

    const events = await admin<{ event: string }[]>`
      SELECT event FROM order_events WHERE order_id = ${orderId}`;
    expect(events.map((e) => e.event)).toContain("order.cancelled");
  });

  it("cancel of a captured prepaid order inserts the refund intent + refund_initiated", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const { orderId, amountPaise } = await confirmedPrepaidOrder(variant);

    await cancelOrder(writeCtx(), orderId, {});

    const order = await orderRow(orderId);
    expect(order.status).toBe("cancelled");
    expect(order.cancel_reason).toBe("merchant_cancelled");
    expect(order.payment_status).toBe("refund_initiated");

    const refundRows = await admin<Record<string, unknown>[]>`
      SELECT * FROM refunds WHERE order_id = ${orderId}`;
    expect(refundRows.length).toBe(1);
    expect(refundRows[0]!.status).toBe("pending");
    expect(refundRows[0]!.reason).toBe("merchant_cancelled");
    expect(Number(refundRows[0]!.amount_paise)).toBe(amountPaise);
    expect(refundRows[0]!.created_by_user_id).toBe(userA);

    const events = await admin<{ event: string }[]>`
      SELECT event FROM order_events WHERE order_id = ${orderId}`;
    expect(events.map((e) => e.event)).toContain("payment.refund_initiated");

    // The enqueue is fail-soft, so a rejected job id (BullMQ refuses ":")
    // passes every DB assertion above while stranding the refund. Assert
    // the job actually landed in the payments queue.
    const paymentsQueue = new Queue(QUEUE_NAMES.payments, { connection: redis() });
    try {
      const job = await paymentsQueue.getJob(`refund-${String(refundRows[0]!.id)}`);
      expect(job).toBeTruthy();
    } finally {
      await paymentsQueue.close();
    }
  });

  it("a double-cancel race resolves on the refunds UNIQUE: ONE refund row (D6)", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const { orderId } = await confirmedPrepaidOrder(variant);

    const outcomes = await Promise.allSettled([
      cancelOrder(writeCtx(), orderId, {}),
      cancelOrder(writeCtx(), orderId, {}),
    ]);
    // One cancel wins; the loser refuses on the transition (409 belt or
    // 422 invalid_transition, depending on where it lost the race).
    expect(outcomes.filter((o) => o.status === "fulfilled").length).toBeGreaterThanOrEqual(1);

    const refundRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM refunds WHERE order_id = ${orderId}`;
    expect(refundRows[0]!.n).toBe(1);
    // And the restock landed exactly once.
    const restocks = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stock_movements
      WHERE reference_type = 'order' AND reference_id = ${orderId} AND reason = 'cancellation_restock'`;
    expect(restocks[0]!.n).toBe(1);
  });

  it("cancel at/after ready_to_ship is a 422 invalid_transition", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const { orderId } = await confirmedPrepaidOrder(variant);

    // Walk the manual ladder to shipped through the one status writer.
    await withTenant(tenantA, async (tx) => {
      const actor = { tenantId: tenantA, actorType: "staff" as const, actorUserId: userA };
      await transitionOrder(tx, actor, { id: orderId, status: "confirmed" }, "processing", {
        name: "order.processing",
      });
      await transitionOrder(tx, actor, { id: orderId, status: "processing" }, "ready_to_ship", {
        name: "order.ready_to_ship",
      });
      await transitionOrder(tx, actor, { id: orderId, status: "ready_to_ship" }, "shipped", {
        name: "order.shipped",
      });
    });

    await expect(cancelOrder(writeCtx(), orderId, {})).rejects.toMatchObject({
      code: "invalid_transition",
      status: 422,
    });
    expect((await orderRow(orderId)).status).toBe("shipped");
  });

  it("cancel of a pending_payment order is refused — expiry owns that path", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const res = await startCheckout(ctx(), await makeCart([{ variantId: variant, quantity: 1 }]), payload());
    if (res.status !== "payment_required") throw new Error("expected payment_required");
    await expect(cancelOrder(writeCtx(), res.orderId, {})).rejects.toMatchObject({
      code: "invalid_transition",
      status: 422,
    });
  });
});

describe("refund lifecycle (D6)", () => {
  it("the worker's processing mark moves pending → processing exactly once", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const { orderId } = await confirmedPrepaidOrder(variant);
    await cancelOrder(writeCtx(), orderId, {});
    const [refund] = await admin<{ id: string }[]>`
      SELECT id FROM refunds WHERE order_id = ${orderId}`;

    await markRefundProcessing(tenantA, { refundId: refund!.id, gatewayRefundId: "rfnd_x_1" });
    let [row] = await admin<Record<string, unknown>[]>`SELECT * FROM refunds WHERE id = ${refund!.id}`;
    expect(row!.status).toBe("processing");
    expect(row!.gateway_refund_id).toBe("rfnd_x_1");

    // A retried job must not overwrite the gateway id or regress state.
    await markRefundProcessing(tenantA, { refundId: refund!.id, gatewayRefundId: "rfnd_x_2" });
    [row] = await admin<Record<string, unknown>[]>`SELECT * FROM refunds WHERE id = ${refund!.id}`;
    expect(row!.status).toBe("processing");
    expect(row!.gateway_refund_id).toBe("rfnd_x_1");
  });

  it("refund.processed webhook: refund → processed, order → refunded, event written; replay no-ops", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const { orderId } = await confirmedPrepaidOrder(variant);
    await cancelOrder(writeCtx(), orderId, {});
    const [refund] = await admin<{ id: string }[]>`SELECT id FROM refunds WHERE order_id = ${orderId}`;
    await markRefundProcessing(tenantA, { refundId: refund!.id, gatewayRefundId: "rfnd_done_1" });

    const processed: GatewayEvent = {
      eventId: "evt_cnl_" + randomUUID(),
      type: "refund.processed",
      gatewayOrderId: "",
      gatewayRefundId: "rfnd_done_1",
      amountPaise: 49900,
    };
    await deliver(processed);

    const [row] = await admin<Record<string, unknown>[]>`SELECT * FROM refunds WHERE id = ${refund!.id}`;
    expect(row!.status).toBe("processed");
    const order = await orderRow(orderId);
    expect(order.payment_status).toBe("refunded");
    const events = await admin<{ event: string }[]>`
      SELECT event FROM order_events WHERE order_id = ${orderId}`;
    expect(events.filter((e) => e.event === "order.refunded").length).toBe(1);

    // Replay with a fresh delivery id — markRefundProcessed matches no
    // non-terminal row, so nothing moves and no second event lands.
    await deliver({ ...processed, eventId: "evt_cnl_" + randomUUID() });
    const eventsAfter = await admin<{ event: string }[]>`
      SELECT event FROM order_events WHERE order_id = ${orderId}`;
    expect(eventsAfter.filter((e) => e.event === "order.refunded").length).toBe(1);
  });
});

describe("abandoned expiry + late capture (§4.6, D9)", () => {
  it("expireCheckout abandons a lapsed pending order and reverts the cart; holds released", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const res = await startCheckout(ctx(), cartId, payload());
    if (res.status !== "payment_required") throw new Error("expected payment_required");

    await admin`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${res.orderId}`;
    const { outcome } = await expireCheckout(ctx(), res.orderId);
    expect(outcome).toBe("abandoned");

    const order = await orderRow(res.orderId);
    expect(order.status).toBe("abandoned");
    const holds = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stock_reservations
      WHERE reference_type = 'checkout' AND reference_id = ${res.orderId}`;
    expect(holds[0]!.n).toBe(0);
    const [cart] = await admin<{ status: string }[]>`SELECT status FROM carts WHERE id = ${cartId}`;
    expect(cart!.status).toBe("active");
    const events = await admin<{ event: string }[]>`
      SELECT event FROM order_events WHERE order_id = ${res.orderId}`;
    expect(events.map((e) => e.event)).toContain("order.abandoned");
  });

  it("expireCheckout is a no-op on unexpired and already-final orders", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const pending = await startCheckout(ctx(), await makeCart([{ variantId: variant, quantity: 1 }]), payload());
    expect((await expireCheckout(ctx(), pending.orderId)).outcome).toBe("still_pending");

    const confirmed = await confirmedCodOrder(variant);
    expect((await expireCheckout(ctx(), confirmed)).outcome).toBe("already_final");
    expect((await orderRow(confirmed)).status).toBe("confirmed");
  });

  it("a late capture on an ABANDONED order records the money + refund intent; order stays abandoned (D9)", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const res = await startCheckout(ctx(), await makeCart([{ variantId: variant, quantity: 1 }]), payload());
    if (res.status !== "payment_required") throw new Error("expected payment_required");
    await admin`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${res.orderId}`;
    await expireCheckout(ctx(), res.orderId);

    await deliver(capture(res.gatewayOrderId, res.amountPaise));

    const order = await orderRow(res.orderId);
    expect(order.status).toBe("abandoned"); // NO revival — terminal (D9)
    expect(order.payment_status).toBe("refund_initiated");
    expect(Number(order.amount_paid_paise)).toBe(res.amountPaise);

    const [payment] = await admin<Record<string, unknown>[]>`
      SELECT * FROM payments WHERE order_id = ${res.orderId}`;
    expect(payment!.status).toBe("captured");
    expect(Number(payment!.fee_paise)).toBe(118); // D17 even on the late path

    const refunds = await admin<Record<string, unknown>[]>`
      SELECT * FROM refunds WHERE order_id = ${res.orderId}`;
    expect(refunds.length).toBe(1);
    expect(refunds[0]!.reason).toBe("late_capture_abandoned");

    // No invoice, no consumption — the order never confirmed.
    const invoiceRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM invoices WHERE order_id = ${res.orderId}`;
    expect(invoiceRows[0]!.n).toBe(0);
    const movementRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stock_movements
      WHERE reference_type = 'checkout' AND reference_id = ${res.orderId}`;
    expect(movementRows[0]!.n).toBe(0);

    const events = await admin<{ event: string }[]>`
      SELECT event FROM order_events WHERE order_id = ${res.orderId}`;
    expect(events.map((e) => e.event)).toContain("payment.late_captured");
  });

  it("late-capture redelivery keeps ONE refund row and ONE late_captured event", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const res = await startCheckout(ctx(), await makeCart([{ variantId: variant, quantity: 1 }]), payload());
    if (res.status !== "payment_required") throw new Error("expected payment_required");
    await admin`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${res.orderId}`;
    await expireCheckout(ctx(), res.orderId);

    const event = capture(res.gatewayOrderId, res.amountPaise);
    await deliver(event);
    await deliver(event); // same delivery id
    await deliver({ ...capture(res.gatewayOrderId, res.amountPaise) }); // fresh id, same money

    const refunds = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM refunds WHERE order_id = ${res.orderId}`;
    expect(refunds[0]!.n).toBe(1);
    const events = await admin<{ event: string }[]>`
      SELECT event FROM order_events WHERE order_id = ${res.orderId}`;
    expect(events.filter((e) => e.event === "payment.late_captured").length).toBe(1);
    expect(Number((await orderRow(res.orderId)).amount_paid_paise)).toBe(res.amountPaise);
  });
});
