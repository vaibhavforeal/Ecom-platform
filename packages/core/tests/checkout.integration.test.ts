import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeConnections } from "@platform/db";
import { closeRedis, sealCredentials, credentialFingerprint } from "@platform/core";
import {
  confirmCodOrder,
  confirmFromWebhookEvent,
  setGatewayAdapterResolver,
  startCheckout,
} from "@platform/core/checkout/server";
import type { CheckoutPayload } from "@platform/core/checkout";
import { recordMovement } from "@platform/core/inventory/server";
import type { GatewayEvent, PaymentGatewayAdapter } from "@platform/core/payments";
import {
  paymentCredentialsAad,
  paymentWebhookSecretAad,
  recordWebhookEvent,
} from "@platform/core/payments/server";

/**
 * The checkout spine (spec §4.2–§4.4, §9): cart → checkout-start (order
 * + snapshot + hold, order number, cart converted) → confirmation via
 * COD (D5) or the webhook door — invoice, coupon slot, sale movements,
 * events. Idempotency-key replay + fingerprint mismatch (D1a), the
 * cart_id belt after a hold-failure cancel, double webhook delivery, and
 * the zero-total order.
 *
 * The gateway is an in-test adapter injected through
 * setGatewayAdapterResolver — core cannot depend on
 * @platform/integrations, and a deterministic fake makes gateway-call
 * counts assertable.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantA: string;
let userA: string;
let locationA: string;
let planId: string;

const savedEnv = new Map<string, string | undefined>();
let purgeServer: Server;

/** Every gateway createOrder call, for zero-gateway assertions (D5). */
const gatewayCalls: { receipt: string; amountPaise: number }[] = [];

const fakeAdapter: PaymentGatewayAdapter = {
  provider: "mock",
  async createGatewayOrder(_creds, args) {
    gatewayCalls.push({ receipt: args.receipt, amountPaise: args.amountPaise });
    // Deterministic per receipt (= order id): a replayed payment-start
    // behaves like a gateway that deduplicated the request.
    return {
      gatewayOrderId:
        "order_test_" + createHash("sha256").update(args.receipt, "utf8").digest("hex").slice(0, 16),
    };
  },
  verifyWebhook: () => true,
  parseWebhook: () => {
    throw new Error("parseWebhook is route-level; domain tests build GatewayEvent directly");
  },
  async refund(_creds, args) {
    return { gatewayRefundId: "rfnd_test_" + args.idempotencyKey.slice(0, 8) };
  },
};

function ctx() {
  return { tenantId: tenantA, requestId: "checkout-int" };
}

function writeCtx() {
  return { tenantId: tenantA, actorUserId: userA, ip: null, userAgent: null, requestId: "checkout-int" };
}

let phoneCounter = 0;
function freshPhone(): string {
  phoneCounter += 1;
  return "+9198990" + String(phoneCounter).padStart(5, "0");
}

function payload(overrides: Partial<CheckoutPayload> = {}): CheckoutPayload {
  return {
    idempotencyKey: randomUUID(),
    buyerName: "Checkout Tester",
    phone: freshPhone(),
    email: null,
    shippingAddress: {
      line1: "12 MG Road",
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

async function makeVariant(opts: { pricePaise?: number; tracks?: boolean } = {}): Promise<string> {
  const [product] = await admin<{ id: string }[]>`
    INSERT INTO products (id, tenant_id, title, status, hsn_code, tax_rate_bps, published_at)
    VALUES (${randomUUID()}, ${tenantA}, ${"Checkout product " + randomUUID().slice(0, 8)},
            'active', '6109', 1800, now())
    RETURNING id`;
  const [variant] = await admin<{ id: string }[]>`
    INSERT INTO product_variants
      (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory)
    VALUES (${randomUUID()}, ${tenantA}, ${product!.id}, ${"CHK-" + randomUUID().slice(0, 8)},
            ${opts.pricePaise ?? 99900}, 200, ${opts.tracks ?? true})
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

async function makePromotion(opts: {
  code: string;
  effects: unknown[];
  conditions?: unknown[];
  usageLimitTotal?: number | null;
  usageLimitPerCustomer?: number | null;
}): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO promotions
      (id, tenant_id, code, name, status, conditions, effects, usage_limit_total, usage_limit_per_customer)
    VALUES (${randomUUID()}, ${tenantA}, ${opts.code}, ${opts.code}, 'active',
            ${JSON.stringify(opts.conditions ?? [])}::text::jsonb,
            ${JSON.stringify(opts.effects)}::text::jsonb,
            ${opts.usageLimitTotal ?? null}, ${opts.usageLimitPerCustomer ?? null})
    RETURNING id`;
  return row!.id;
}

async function orderRow(orderId: string) {
  const [row] = await admin<Record<string, unknown>[]>`
    SELECT * FROM orders WHERE id = ${orderId}`;
  return row!;
}

async function orderByKey(key: string) {
  const rows = await admin<Record<string, unknown>[]>`
    SELECT * FROM orders WHERE tenant_id = ${tenantA} AND idempotency_key = ${key}`;
  return rows;
}

async function invoiceFor(orderId: string) {
  const rows = await admin<Record<string, unknown>[]>`
    SELECT * FROM invoices WHERE tenant_id = ${tenantA} AND order_id = ${orderId}`;
  return rows;
}

async function saleMovements(orderId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_movements
    WHERE tenant_id = ${tenantA} AND reason = 'sale'
      AND reference_type = 'checkout' AND reference_id = ${orderId}`;
  return row!.n;
}

async function holdCount(orderId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_reservations
    WHERE reference_type = 'checkout' AND reference_id = ${orderId}`;
  return row!.n;
}

async function eventNames(orderId: string): Promise<string[]> {
  const rows = await admin<{ event: string }[]>`
    SELECT event FROM order_events WHERE order_id = ${orderId} ORDER BY created_at, id`;
  return rows.map((r) => r.event);
}

function capturedEvent(gatewayOrderId: string, amountPaise: number, overrides: Partial<GatewayEvent> = {}): GatewayEvent {
  return {
    eventId: "evt_test_" + randomUUID(),
    type: "payment.captured",
    gatewayOrderId,
    gatewayPaymentId: "pay_test_" + randomUUID().slice(0, 12),
    amountPaise,
    method: "upi",
    feePaise: 236,
    feeTaxPaise: 36,
    ...overrides,
  };
}

/** TX-1 + processing, the way the route drives it. */
async function deliverWebhook(event: GatewayEvent): Promise<void> {
  const { webhookEventId } = await recordWebhookEvent(ctx(), {
    providerCode: "mock",
    gatewayEventId: event.eventId,
    eventType: event.type,
    rawPayload: { test: true, event: event.type },
  });
  await confirmFromWebhookEvent(ctx(), { webhookEventId, event });
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
  process.env.SESSION_SECRET ??= "checkout-int-secret-000000000000000000000000000000";
  process.env.CREDENTIALS_MASTER_KEY ??= randomBytes(32).toString("base64");

  // Purge stub on port 0 (brief §6): the confirm paths purge after commit.
  purgeServer = createServer((_req, res) => {
    res.statusCode = 200;
    res.end("{}");
  });
  await new Promise<void>((resolve) => purgeServer.listen(0, "127.0.0.1", resolve));
  const address = purgeServer.address();
  process.env.STOREFRONT_INTERNAL_ORIGIN = `http://127.0.0.1:${(address as { port: number }).port}`;
  process.env.INTERNAL_API_SECRET = "checkout-int-internal";

  setGatewayAdapterResolver(() => fakeAdapter);

  const slug = "chk-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"chk-" + randomUUID().slice(0, 8)}, 'Checkout test plan')
    RETURNING id`;
  planId = plan!.id;
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants
      (id, slug, legal_name, display_name, plan_id, status,
       tax_registration_type, gstin, origin_state_code)
    VALUES (${randomUUID()}, ${slug}, 'Checkout Test Sellers Pvt Ltd', ${slug}, ${plan!.id},
            'active', 'regular', '29ABCDE1234F1Z5', '29')
    RETURNING id`;
  tenantA = tenant!.id;

  userA = randomUUID();
  const phone = "+9197" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userA}, ${phone}, 'Checkout tester')`;

  const [loc] = await admin<{ id: string }[]>`
    INSERT INTO locations (id, tenant_id, name, is_default)
    VALUES (${randomUUID()}, ${tenantA}, 'Default', true)
    RETURNING id`;
  locationA = loc!.id;

  // Enabled mock gateway account, TWO sealed blobs (D7).
  const sealedCredentials = sealCredentials(
    { keyId: "mock_pub_chk", keySecret: "mock_secret_chk" },
    paymentCredentialsAad(tenantA, "mock"),
  );
  const sealedWebhookSecret = sealCredentials(
    { webhookSecret: "mock_webhook_chk" },
    paymentWebhookSecretAad(tenantA, "mock"),
  );
  await admin`
    INSERT INTO payment_accounts
      (id, tenant_id, provider_code, label, public_key_id,
       sealed_credentials, sealed_webhook_secret, credential_fingerprint, is_enabled)
    VALUES (${randomUUID()}, ${tenantA}, 'mock', 'Default', 'mock_pub_chk',
            ${sealedCredentials}, ${sealedWebhookSecret},
            ${credentialFingerprint(sealedCredentials)}, true)`;
});

afterAll(async () => {
  // Env restored BEFORE the pools close (the worker-suite lesson).
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

describe("checkout-start spine (§4.2)", () => {
  it("creates the snapshot order, hold, converted cart and gateway hand-off", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const p = payload();

    const res = await startCheckout(ctx(), cartId, p);
    expect(res.status).toBe("payment_required");
    if (res.status !== "payment_required") throw new Error("unreachable");
    expect(res.gatewayOrderId).toMatch(/^order_test_/);
    expect(res.publicKeyId).toBe("mock_pub_chk");
    expect(res.amountPaise).toBe(99900);
    expect(res.orderToken.length).toBeGreaterThan(20);

    const order = await orderRow(res.orderId);
    expect(order.status).toBe("pending_payment");
    expect(Number(order.order_number)).toBeGreaterThanOrEqual(1001);
    expect(order.checkout_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(order.place_of_supply).toBe("07");
    expect(Number(order.subtotal_paise)).toBe(99900);
    expect(Number(order.total_paise)).toBe(99900);
    expect(order.gateway_order_ref).toBe(res.gatewayOrderId);
    expect(order.expires_at).not.toBeNull();

    // Snapshot line with the D20 pinned inter-state vector:
    // 99900 @ 18% inclusive → tax 15239, all IGST ('29' → '07').
    const lines = await admin<Record<string, unknown>[]>`
      SELECT * FROM order_lines WHERE order_id = ${res.orderId} ORDER BY position`;
    expect(lines.length).toBe(1);
    expect(lines[0]!.kind).toBe("item");
    expect(lines[0]!.hsn_snapshot).toBe("6109");
    expect(Number(lines[0]!.unit_price_paise)).toBe(99900);
    expect(Number(lines[0]!.igst_paise)).toBe(15239);
    expect(Number(lines[0]!.cgst_paise)).toBe(0);
    expect(Number(lines[0]!.taxable_paise)).toBe(99900 - 15239);

    expect(await holdCount(res.orderId)).toBe(1);
    const [cart] = await admin<{ status: string }[]>`SELECT status FROM carts WHERE id = ${cartId}`;
    expect(cart!.status).toBe("converted");

    const paymentRows = await admin<Record<string, unknown>[]>`
      SELECT * FROM payments WHERE order_id = ${res.orderId}`;
    expect(paymentRows.length).toBe(1);
    expect(paymentRows[0]!.status).toBe("created");
    expect(Number(paymentRows[0]!.amount_paise)).toBe(99900);

    expect(await eventNames(res.orderId)).toContain("order.placed");
  });

  it("allocates consecutive order numbers within the tenant", async () => {
    const variant = await makeVariant({ tracks: false });
    const first = await startCheckout(ctx(), await makeCart([{ variantId: variant, quantity: 1 }]), payload());
    const second = await startCheckout(ctx(), await makeCart([{ variantId: variant, quantity: 1 }]), payload());
    const a = Number((await orderRow(first.orderId)).order_number);
    const b = Number((await orderRow(second.orderId)).order_number);
    expect(b).toBe(a + 1);
  });

  it("shipping fee from settings becomes a taxed shipping line; free-above waives it", async () => {
    await admin`
      INSERT INTO store_settings (tenant_id, key, value)
      VALUES (${tenantA}, 'shipping.flat_fee_paise', ${"5000"}::text::jsonb),
             (${tenantA}, 'shipping.free_above_paise', ${"200000"}::text::jsonb)`;
    try {
      const variant = await makeVariant();
      await seed(variant, 10);

      // Below the threshold → the fee applies as a taxed shipping line.
      const below = await startCheckout(ctx(), await makeCart([{ variantId: variant, quantity: 1 }]), payload());
      const belowOrder = await orderRow(below.orderId);
      expect(Number(belowOrder.shipping_paise)).toBe(5000);
      expect(Number(belowOrder.total_paise)).toBe(99900 + 5000);
      const shippingLines = await admin<Record<string, unknown>[]>`
        SELECT * FROM order_lines WHERE order_id = ${below.orderId} AND kind = 'shipping'`;
      expect(shippingLines.length).toBe(1);
      expect(Number(shippingLines[0]!.total_paise)).toBe(5000);
      expect(Number(shippingLines[0]!.tax_rate_bps)).toBe(1800); // highest item line's rate
      expect(Number(shippingLines[0]!.igst_paise)).toBeGreaterThan(0);

      // At/above the threshold → waived, no shipping line at all.
      const above = await startCheckout(
        ctx(),
        await makeCart([{ variantId: variant, quantity: 3 }]),
        payload(),
      );
      const aboveOrder = await orderRow(above.orderId);
      expect(Number(aboveOrder.shipping_paise)).toBe(0);
      const none = await admin<{ n: number }[]>`
        SELECT count(*)::int AS n FROM order_lines WHERE order_id = ${above.orderId} AND kind = 'shipping'`;
      expect(none[0]!.n).toBe(0);
    } finally {
      await admin`
        DELETE FROM store_settings
        WHERE tenant_id = ${tenantA} AND key IN ('shipping.flat_fee_paise', 'shipping.free_above_paise')`;
    }
  });

  it("pincode/state mismatch is a 422 with the allowed states, and no order is written (D3)", async () => {
    const variant = await makeVariant({ tracks: false });
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const p = payload({
      shippingAddress: { line1: "12 MG Road", line2: null, city: "Delhi", stateCode: "29", pincode: "110001" },
    });
    await expect(startCheckout(ctx(), cartId, p)).rejects.toMatchObject({
      code: "pincode_state_mismatch",
      status: 422,
      details: expect.objectContaining({ allowedStates: expect.arrayContaining(["07"]) }),
    });
    expect((await orderByKey(p.idempotencyKey)).length).toBe(0);
  });

  it("an unknown pincode prefix fails open on the cross-check (COD confirms)", async () => {
    const variant = await makeVariant({ tracks: false });
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    // Prefix 99 (army range) is deliberately absent from the map.
    const p = payload({
      paymentMode: "cod",
      shippingAddress: { line1: "Post 9", line2: null, city: "Field", stateCode: "07", pincode: "990001" },
    });
    const res = await startCheckout(ctx(), cartId, p);
    expect(res.status).toBe("confirmed");
  });

  it("a list serviceability policy refuses out-of-zone pincodes as pincode_unserviceable", async () => {
    await admin`
      INSERT INTO store_settings (tenant_id, key, value)
      VALUES (${tenantA}, 'shipping.pincode_policy',
              ${'{"mode":"list","allowedPrefixes":["56"]}'}::text::jsonb)`;
    try {
      const variant = await makeVariant({ tracks: false });
      const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
      const p = payload(); // 110001 — outside the "56" zone
      await expect(startCheckout(ctx(), cartId, p)).rejects.toMatchObject({
        code: "pincode_unserviceable",
        status: 422,
      });
      expect((await orderByKey(p.idempotencyKey)).length).toBe(0);
    } finally {
      await admin`
        DELETE FROM store_settings WHERE tenant_id = ${tenantA} AND key = 'shipping.pincode_policy'`;
    }
  });

  it("COD is refused when the merchant disabled it (payments.cod_enabled = false)", async () => {
    await admin`
      INSERT INTO store_settings (tenant_id, key, value)
      VALUES (${tenantA}, 'payments.cod_enabled', ${"false"}::text::jsonb)`;
    try {
      const variant = await makeVariant({ tracks: false });
      const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
      await expect(startCheckout(ctx(), cartId, payload({ paymentMode: "cod" }))).rejects.toMatchObject({
        code: "invalid_payload",
        status: 422,
      });
    } finally {
      await admin`
        DELETE FROM store_settings WHERE tenant_id = ${tenantA} AND key = 'payments.cod_enabled'`;
    }
  });
});

describe("idempotency (D1a)", () => {
  it("same key + same fingerprint replays the SAME order and refreshes the TTL", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const p = payload();

    const first = await startCheckout(ctx(), cartId, p);
    const expiresBefore = (await orderRow(first.orderId)).expires_at as Date;

    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await startCheckout(ctx(), cartId, p);
    expect(second.orderId).toBe(first.orderId);
    expect(second.status).toBe("payment_required");
    if (first.status === "payment_required" && second.status === "payment_required") {
      expect(second.gatewayOrderId).toBe(first.gatewayOrderId);
    }
    expect((await orderByKey(p.idempotencyKey)).length).toBe(1);

    const expiresAfter = (await orderRow(first.orderId)).expires_at as Date;
    expect(new Date(expiresAfter).getTime()).toBeGreaterThanOrEqual(new Date(expiresBefore).getTime());
    // The hold was re-placed (replace semantics), not duplicated.
    expect(await holdCount(first.orderId)).toBe(1);
  });

  it("same key + different fingerprint is a 422 idempotency_key_reuse", async () => {
    const variant = await makeVariant({ tracks: false });
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const p = payload();
    await startCheckout(ctx(), cartId, p);

    const tampered: CheckoutPayload = {
      ...p,
      shippingAddress: { ...p.shippingAddress, stateCode: "29", pincode: "560001" },
    };
    await expect(startCheckout(ctx(), cartId, tampered)).rejects.toMatchObject({
      code: "idempotency_key_reuse",
      status: 422,
    });
  });

  it("hold failure cancels the order (event order.hold_failed) and the SAME cart retries clean (D1a belt)", async () => {
    const variant = await makeVariant();
    await seed(variant, 1);
    // A competitor's ACTIVE hold takes the only unit.
    const competitorRef = randomUUID();
    await admin`
      INSERT INTO stock_reservations
        (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
      VALUES (${randomUUID()}, ${tenantA}, ${variant}, ${locationA}, 1,
              'checkout', ${competitorRef}, now() + interval '15 minutes')`;

    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const p = payload({ paymentMode: "cod" });
    await expect(startCheckout(ctx(), cartId, p)).rejects.toMatchObject({
      code: "insufficient_stock",
      status: 422,
    });

    const [cancelled] = await orderByKey(p.idempotencyKey);
    expect(cancelled!.status).toBe("cancelled");
    expect(cancelled!.cancel_reason).toBe("hold_failed");
    expect(await eventNames(cancelled!.id as string)).toContain("order.hold_failed");
    // No invoice, no movements, and the cart is usable again.
    expect((await invoiceFor(cancelled!.id as string)).length).toBe(0);
    expect(await saleMovements(cancelled!.id as string)).toBe(0);
    const [cart] = await admin<{ status: string }[]>`SELECT status FROM carts WHERE id = ${cartId}`;
    expect(cart!.status).toBe("active");

    // Free the unit; a FRESH key on the SAME cart succeeds.
    await admin`DELETE FROM stock_reservations WHERE reference_id = ${competitorRef}`;
    const retry = await startCheckout(ctx(), cartId, payload({ paymentMode: "cod", phone: p.phone }));
    expect(retry.status).toBe("confirmed");
    expect(retry.orderId).not.toBe(cancelled!.id);
  });

  it("a NEW key against a cart that is already pending is a typed refusal", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    await startCheckout(ctx(), cartId, payload());
    await expect(startCheckout(ctx(), cartId, payload())).rejects.toMatchObject({
      code: "cart_not_active",
      status: 422,
    });
  });

  it("a concurrent double-POST with the same key resolves to ONE order", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const p = payload();

    const [a, b] = await Promise.all([
      startCheckout(ctx(), cartId, p),
      startCheckout(ctx(), cartId, p),
    ]);
    expect(a.orderId).toBe(b.orderId);
    expect((await orderByKey(p.idempotencyKey)).length).toBe(1);
  });

  it("a replayed confirmed COD checkout returns the confirmed arm", async () => {
    const variant = await makeVariant({ tracks: false });
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const p = payload({ paymentMode: "cod" });
    const first = await startCheckout(ctx(), cartId, p);
    expect(first.status).toBe("confirmed");

    const replay = await startCheckout(ctx(), cartId, p);
    expect(replay).toMatchObject({ orderId: first.orderId, status: "confirmed" });
    // Still exactly one invoice — the replay confirmed nothing again.
    expect((await invoiceFor(first.orderId)).length).toBe(1);
  });
});

describe("COD confirms at placement (D5)", () => {
  it("COD: confirmed with sale movements, invoice in the same flow, ZERO gateway involvement", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const cartId = await makeCart([{ variantId: variant, quantity: 2 }]);
    const gatewayCallsBefore = gatewayCalls.length;

    const res = await startCheckout(ctx(), cartId, payload({ paymentMode: "cod" }));
    expect(res.status).toBe("confirmed");
    expect(gatewayCalls.length).toBe(gatewayCallsBefore);

    const order = await orderRow(res.orderId);
    expect(order.status).toBe("confirmed");
    expect(order.confirmed_at).not.toBeNull();
    expect(order.expires_at).toBeNull();
    expect(order.payment_status).toBe("pending");
    expect(Number(order.cod_due_paise)).toBe(Number(order.total_paise));

    const paymentRows = await admin<{ id: string }[]>`
      SELECT id FROM payments WHERE order_id = ${res.orderId}`;
    expect(paymentRows.length).toBe(0);

    expect(await saleMovements(res.orderId)).toBe(1);
    expect(await holdCount(res.orderId)).toBe(0);

    const invoices = await invoiceFor(res.orderId);
    expect(invoices.length).toBe(1);
    expect(invoices[0]!.doc_type).toBe("tax_invoice"); // tenant is GST-regular
    expect(invoices[0]!.invoice_number).toMatch(/^INV\/\d{4}-\d{2}\/\d{4,}$/);
    expect(Number(invoices[0]!.total_paise)).toBe(Number(order.total_paise));
    expect(Array.isArray(invoices[0]!.lines)).toBe(true);

    const names = await eventNames(res.orderId);
    expect(names).toContain("order.placed");
    expect(names).toContain("order.confirmed");
  });

  it("a pending prepaid checkout consumes NO invoice number", async () => {
    const before = await admin<{ next: number }[]>`
      SELECT next_number::int AS next FROM invoice_series
      WHERE tenant_id = ${tenantA} AND series_code = 'INV'`;
    const variant = await makeVariant();
    await seed(variant, 5);
    await startCheckout(ctx(), await makeCart([{ variantId: variant, quantity: 1 }]), payload());
    const after = await admin<{ next: number }[]>`
      SELECT next_number::int AS next FROM invoice_series
      WHERE tenant_id = ${tenantA} AND series_code = 'INV'`;
    expect(after[0]?.next ?? 1).toBe(before[0]?.next ?? 1);
  });

  it("a zero-total order (100% off) confirms as paid with the gateway skipped and the slot claimed", async () => {
    const promoId = await makePromotion({
      code: "FREEBIE" + randomUUID().slice(0, 4).toUpperCase().replaceAll("-", ""),
      effects: [{ type: "percent_off", bps: 10000 }],
    });
    const [promo] = await admin<{ code: string }[]>`SELECT code FROM promotions WHERE id = ${promoId}`;
    const variant = await makeVariant();
    await seed(variant, 5);
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const gatewayCallsBefore = gatewayCalls.length;

    const res = await startCheckout(
      ctx(),
      cartId,
      payload({ paymentMode: "prepaid", couponCode: promo!.code }),
    );
    expect(res.status).toBe("confirmed");
    expect(gatewayCalls.length).toBe(gatewayCallsBefore);

    const order = await orderRow(res.orderId);
    expect(order.status).toBe("confirmed");
    expect(order.payment_status).toBe("paid");
    expect(Number(order.total_paise)).toBe(0);
    expect(Number(order.discount_paise)).toBe(99900);
    expect(Number(order.cod_due_paise)).toBe(0);

    const redemptions = await admin<Record<string, unknown>[]>`
      SELECT * FROM coupon_redemptions WHERE promotion_id = ${promoId} AND order_id = ${res.orderId}`;
    expect(redemptions.length).toBe(1);
    expect(Number(redemptions[0]!.discount_paise)).toBe(99900);
    expect((await invoiceFor(res.orderId)).length).toBe(1);
  });

  it("COD oversold (stolen unit): cancel + order.oversold, NO invoice, NO redemption, buyer-worded 422 (D2a)", async () => {
    const variant = await makeVariant();
    await seed(variant, 1);
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    // A pending prepaid order holds the flow open so the theft window exists.
    const start = await startCheckout(ctx(), cartId, payload());
    expect(start.status).toBe("payment_required");

    // The theft: the unit vanishes underneath the hold.
    await admin`
      UPDATE stock_levels SET on_hand = 0
      WHERE tenant_id = ${tenantA} AND variant_id = ${variant}`;

    await expect(confirmCodOrder(ctx(), start.orderId)).rejects.toMatchObject({
      code: "insufficient_stock",
      status: 422,
    });

    const order = await orderRow(start.orderId);
    expect(order.status).toBe("cancelled");
    expect(order.cancel_reason).toBe("stock_shortfall");
    expect(await eventNames(start.orderId)).toContain("order.oversold");
    expect((await invoiceFor(start.orderId)).length).toBe(0);
    expect(await saleMovements(start.orderId)).toBe(0);
    // Repair the projection for later reconciles (the theft bypassed the ledger).
    await admin`
      UPDATE stock_levels SET on_hand = 1
      WHERE tenant_id = ${tenantA} AND variant_id = ${variant}`;
  });
});

describe("webhook confirm (§4.4)", () => {
  it("payment.captured confirms: consume from ORDER lines, invoice in-tx, fee fields on the payment row (D17)", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const start = await startCheckout(ctx(), cartId, payload());
    if (start.status !== "payment_required") throw new Error("expected payment_required");

    const event = capturedEvent(start.gatewayOrderId, start.amountPaise);
    await deliverWebhook(event);

    const order = await orderRow(start.orderId);
    expect(order.status).toBe("confirmed");
    expect(order.payment_status).toBe("paid");
    expect(Number(order.amount_paid_paise)).toBe(start.amountPaise);
    expect(order.expires_at).toBeNull();

    const [payment] = await admin<Record<string, unknown>[]>`
      SELECT * FROM payments WHERE order_id = ${start.orderId}`;
    expect(payment!.status).toBe("captured");
    expect(payment!.gateway_payment_id).toBe(event.gatewayPaymentId);
    expect(payment!.method).toBe("upi");
    expect(Number(payment!.fee_paise)).toBe(236);
    expect(Number(payment!.fee_tax_paise)).toBe(36);

    expect(await saleMovements(start.orderId)).toBe(1);
    expect((await invoiceFor(start.orderId)).length).toBe(1);
    expect(await eventNames(start.orderId)).toContain("order.confirmed");
  });

  it("double delivery of the same gateway event id: deduped evidence, ONE confirmation", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const start = await startCheckout(ctx(), await makeCart([{ variantId: variant, quantity: 1 }]), payload());
    if (start.status !== "payment_required") throw new Error("expected payment_required");

    const event = capturedEvent(start.gatewayOrderId, start.amountPaise);
    const first = await recordWebhookEvent(ctx(), {
      providerCode: "mock",
      gatewayEventId: event.eventId,
      eventType: event.type,
      rawPayload: {},
    });
    expect(first.duplicate).toBe(false);
    await confirmFromWebhookEvent(ctx(), { webhookEventId: first.webhookEventId, event });

    const second = await recordWebhookEvent(ctx(), {
      providerCode: "mock",
      gatewayEventId: event.eventId,
      eventType: event.type,
      rawPayload: {},
    });
    expect(second.duplicate).toBe(true);
    expect(second.webhookEventId).toBe(first.webhookEventId);
    await confirmFromWebhookEvent(ctx(), { webhookEventId: second.webhookEventId, event });

    const order = await orderRow(start.orderId);
    expect(Number(order.amount_paid_paise)).toBe(start.amountPaise); // not doubled
    expect((await invoiceFor(start.orderId)).length).toBe(1);
    expect(await saleMovements(start.orderId)).toBe(1);
    const evidence = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_webhook_events
      WHERE tenant_id = ${tenantA} AND gateway_event_id = ${event.eventId}`;
    expect(evidence[0]!.n).toBe(1);
  });

  it("amount mismatch: payment failed + flag event, NO state advance", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const start = await startCheckout(ctx(), await makeCart([{ variantId: variant, quantity: 1 }]), payload());
    if (start.status !== "payment_required") throw new Error("expected payment_required");

    await deliverWebhook(capturedEvent(start.gatewayOrderId, start.amountPaise - 1));

    const order = await orderRow(start.orderId);
    expect(order.status).toBe("pending_payment");
    expect(Number(order.amount_paid_paise)).toBe(0);
    const [payment] = await admin<Record<string, unknown>[]>`
      SELECT * FROM payments WHERE order_id = ${start.orderId}`;
    expect(payment!.status).toBe("failed");
    expect(payment!.error_code).toBe("amount_mismatch");
    expect(await eventNames(start.orderId)).toContain("payment.amount_mismatch");
    expect((await invoiceFor(start.orderId)).length).toBe(0);
  });

  it("payment.failed records the failure and leaves the order pending for retry", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const start = await startCheckout(ctx(), await makeCart([{ variantId: variant, quantity: 1 }]), payload());
    if (start.status !== "payment_required") throw new Error("expected payment_required");

    await deliverWebhook({
      eventId: "evt_test_" + randomUUID(),
      type: "payment.failed",
      gatewayOrderId: start.gatewayOrderId,
      gatewayPaymentId: "pay_test_" + randomUUID().slice(0, 12),
      amountPaise: start.amountPaise,
      error: { code: "BAD_UPI", description: "The UPI transaction failed." },
    });

    const order = await orderRow(start.orderId);
    expect(order.status).toBe("pending_payment");
    const [payment] = await admin<Record<string, unknown>[]>`
      SELECT * FROM payments WHERE order_id = ${start.orderId}`;
    expect(payment!.status).toBe("failed");
    expect(payment!.error_code).toBe("BAD_UPI");
    expect(await eventNames(start.orderId)).toContain("payment.failed");
  });

  it("an unknown gateway order ref is acknowledged and ignored (send-test-event contract, D19)", async () => {
    await expect(
      deliverWebhook(capturedEvent("order_mock_test_" + randomUUID(), 100)),
    ).resolves.toBeUndefined();
  });

  it("checkout-start advisory counts pending claims: the last slot refuses a second checkout (D8)", async () => {
    const promoId = await makePromotion({
      code: "LAST" + randomUUID().slice(0, 6).toUpperCase().replaceAll("-", ""),
      effects: [{ type: "flat_off", paise: 1000 }],
      usageLimitTotal: 1,
    });
    const [promo] = await admin<{ code: string }[]>`SELECT code FROM promotions WHERE id = ${promoId}`;
    const variant = await makeVariant();
    await seed(variant, 5);

    const first = await startCheckout(
      ctx(),
      await makeCart([{ variantId: variant, quantity: 1 }]),
      payload({ couponCode: promo!.code }),
    );
    expect(first.status).toBe("payment_required"); // pending claim, unexpired

    await expect(
      startCheckout(
        ctx(),
        await makeCart([{ variantId: variant, quantity: 1 }]),
        payload({ couponCode: promo!.code }),
      ),
    ).rejects.toMatchObject({ code: "coupon_exhausted", status: 422 });
  });
});
