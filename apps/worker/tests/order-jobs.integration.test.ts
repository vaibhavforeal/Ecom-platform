import { createHash, randomBytes, randomUUID } from "node:crypto";

import { closeRedis, credentialFingerprint, sealCredentials } from "@platform/core";
import {
  paymentCredentialsAad,
  paymentWebhookSecretAad,
} from "@platform/core/payments/server";
import { closeConnections, eq, orders, withTenant } from "@platform/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { processGatewayRefund } from "../src/jobs/gateway-refund";
import { handleOrdersJob } from "../src/jobs/order-events";
import { sweepCheckouts } from "../src/jobs/sweep-checkouts";
import { closeQueues, ordersQueue } from "../src/queues";

/**
 * The order jobs against real Postgres (spec §4.6 D10, §4.7.2): the
 * delayed expiry driver (abandon + release, skip paid, re-enqueue on an
 * extended TTL), the sweep backstop (grace window, SKIP LOCKED under an
 * in-flight confirm, per-tenant iteration), and the refund job's
 * idempotency-key pass-through to the gateway adapter.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 4, onnotice: () => {} });

const createdTenants: string[] = [];
const createdPlans: string[] = [];

let tenantA: string;
let locationA: string;
let variantA: string;
let savedMasterKey: string | undefined;

async function makeTenant(): Promise<{ tenantId: string; locationId: string; variantId: string }> {
  const slug = "ojobs-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"ojobs-" + randomUUID().slice(0, 8)}, 'Order jobs test plan')
    RETURNING id`;
  createdPlans.push(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  createdTenants.push(tenant!.id);

  const [loc] = await admin<{ id: string }[]>`
    INSERT INTO locations (id, tenant_id, name, is_default)
    VALUES (${randomUUID()}, ${tenant!.id}, 'Default', true)
    RETURNING id`;
  const [product] = await admin<{ id: string }[]>`
    INSERT INTO products (id, tenant_id, title, status)
    VALUES (${randomUUID()}, ${tenant!.id}, 'Order jobs product', 'active')
    RETURNING id`;
  const [variant] = await admin<{ id: string }[]>`
    INSERT INTO product_variants
      (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory)
    VALUES (${randomUUID()}, ${tenant!.id}, ${product!.id},
            ${"OJ-" + randomUUID().slice(0, 8)}, 49900, 100, true)
    RETURNING id`;
  return { tenantId: tenant!.id, locationId: loc!.id, variantId: variant!.id };
}

/** A pending_payment order shaped like checkout-start left it. */
async function makePendingOrder(
  tenantId: string,
  opts: { expiresOffsetMinutes: number; cartId?: string | null; status?: string } = {
    expiresOffsetMinutes: -30,
  },
): Promise<string> {
  const [counter] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM orders WHERE tenant_id = ${tenantId}`;
  const [order] = await admin<{ id: string }[]>`
    INSERT INTO orders
      (id, tenant_id, order_number, status, payment_status, cart_id,
       buyer_name, buyer_phone_e164, shipping_address, place_of_supply, payment_mode,
       subtotal_paise, discount_paise, shipping_paise, tax_paise, total_paise,
       expires_at)
    VALUES
      (${randomUUID()}, ${tenantId}, ${5001 + counter!.n}, ${opts.status ?? "pending_payment"},
       'pending', ${opts.cartId ?? null},
       'Jobs Tester', '+919899000001',
       ${'{"line1":"1 Sweep Rd","city":"Delhi","state_code":"07","pincode":"110001"}'}::text::jsonb,
       '07', 'prepaid', 49900, 0, 0, 0, 49900,
       now() + make_interval(mins => ${opts.expiresOffsetMinutes}))
    RETURNING id`;
  return order!.id;
}

async function makeHold(tenantId: string, locationId: string, variantId: string, orderId: string) {
  await admin`
    INSERT INTO stock_levels (tenant_id, variant_id, location_id, on_hand)
    VALUES (${tenantId}, ${variantId}, ${locationId}, 5)
    ON CONFLICT DO NOTHING`;
  await admin`
    INSERT INTO stock_reservations
      (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
    VALUES (${randomUUID()}, ${tenantId}, ${variantId}, ${locationId}, 1,
            'checkout', ${orderId}, now() - interval '1 minute')`;
}

async function orderStatus(orderId: string): Promise<string> {
  const [row] = await admin<{ status: string }[]>`SELECT status FROM orders WHERE id = ${orderId}`;
  return row!.status;
}

beforeAll(async () => {
  savedMasterKey = process.env.CREDENTIALS_MASTER_KEY;
  process.env.CREDENTIALS_MASTER_KEY ??= randomBytes(32).toString("base64");
  const a = await makeTenant();
  tenantA = a.tenantId;
  locationA = a.locationId;
  variantA = a.variantId;
});

afterAll(async () => {
  if (savedMasterKey === undefined) delete process.env.CREDENTIALS_MASTER_KEY;
  else process.env.CREDENTIALS_MASTER_KEY = savedMasterKey;
  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  await closeQueues();
  await closeRedis();
  await closeConnections();
});

describe("checkout.expire (the delayed D10 driver)", () => {
  it("abandons a lapsed pending order, releases its holds, reverts the cart", async () => {
    const [cart] = await admin<{ id: string }[]>`
      INSERT INTO carts (id, tenant_id, status) VALUES (${randomUUID()}, ${tenantA}, 'converted')
      RETURNING id`;
    const orderId = await makePendingOrder(tenantA, { expiresOffsetMinutes: -30, cartId: cart!.id });
    await makeHold(tenantA, locationA, variantA, orderId);

    const result = await handleOrdersJob({
      name: "checkout.expire",
      data: { tenantId: tenantA, orderId },
    });
    expect(result.outcome).toBe("abandoned");
    expect(await orderStatus(orderId)).toBe("abandoned");

    const holds = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stock_reservations
      WHERE reference_type = 'checkout' AND reference_id = ${orderId}`;
    expect(holds[0]!.n).toBe(0);
    const [cartAfter] = await admin<{ status: string }[]>`SELECT status FROM carts WHERE id = ${cart!.id}`;
    expect(cartAfter!.status).toBe("active");
    const events = await admin<{ event: string }[]>`
      SELECT event FROM order_events WHERE order_id = ${orderId}`;
    expect(events.map((e) => e.event)).toContain("order.abandoned");
  });

  it("skips an order that already left pending_payment (a paid webhook won)", async () => {
    const orderId = await makePendingOrder(tenantA, {
      expiresOffsetMinutes: -30,
      status: "confirmed",
    });
    const result = await handleOrdersJob({
      name: "checkout.expire",
      data: { tenantId: tenantA, orderId },
    });
    expect(result.outcome).toBe("already_final");
    expect(await orderStatus(orderId)).toBe("confirmed");
  });

  it("re-enqueues itself at the EXTENDED expiry when a retry moved expires_at forward", async () => {
    const orderId = await makePendingOrder(tenantA, { expiresOffsetMinutes: 20 });
    const result = await handleOrdersJob({
      name: "checkout.expire",
      data: { tenantId: tenantA, orderId },
    });
    expect(result.outcome).toBe("still_pending");
    expect(await orderStatus(orderId)).toBe("pending_payment");

    const expiresAt = await withTenant(tenantA, async (tx) => {
      const [row] = await tx
        .select({ expiresAt: orders.expiresAt })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      return row!.expiresAt!;
    });
    const job = await ordersQueue.getJob(`checkout-expire:${orderId}:${expiresAt.getTime()}`);
    expect(job).toBeTruthy();
    expect(job!.name).toBe("checkout.expire");
    await job!.remove();
  });
});

describe("sweep-checkouts (the D10 backstop)", () => {
  it("honours the +5 min grace: freshly-lapsed orders wait, long-lapsed ones abandon", async () => {
    const fresh = await makePendingOrder(tenantA, { expiresOffsetMinutes: -2 }); // inside grace
    const stale = await makePendingOrder(tenantA, { expiresOffsetMinutes: -10 }); // past grace

    const result = await sweepCheckouts();
    expect(result.tenantsSwept).toBeGreaterThanOrEqual(1);
    expect(await orderStatus(fresh)).toBe("pending_payment");
    expect(await orderStatus(stale)).toBe("abandoned");
  });

  it("SKIP LOCKED: a row held by an in-flight confirm is left alone, then swept next round", async () => {
    const orderId = await makePendingOrder(tenantA, { expiresOffsetMinutes: -10 });

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let lockTaken!: () => void;
    const lockedSignal = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });

    // An "in-flight confirm": a transaction holding the order row lock.
    const locker = withTenant(tenantA, async (tx) => {
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("update");
      lockTaken();
      await gate;
    });

    await lockedSignal;
    const during = await sweepCheckouts();
    // The sweep returned without queueing behind the lock, and the locked
    // order is untouched.
    expect(await orderStatus(orderId)).toBe("pending_payment");
    expect(during.tenantsSwept).toBeGreaterThanOrEqual(1);

    releaseGate();
    await locker;

    await sweepCheckouts();
    expect(await orderStatus(orderId)).toBe("abandoned");
  });

  it("iterates tenants — a cross-tenant query would silently sweep nothing", async () => {
    const b = await makeTenant();
    const inA = await makePendingOrder(tenantA, { expiresOffsetMinutes: -10 });
    const inB = await makePendingOrder(b.tenantId, { expiresOffsetMinutes: -10 });

    const result = await sweepCheckouts();
    expect(result.tenantsSwept).toBeGreaterThanOrEqual(2);
    expect(await orderStatus(inA)).toBe("abandoned");
    expect(await orderStatus(inB)).toBe("abandoned");
  });
});

describe("gateway-refund job (§4.7.2)", () => {
  async function makeRefundFixture(): Promise<{ refundId: string; paymentId: string; orderId: string }> {
    // Enabled mock account with real sealed blobs (the job unseals the
    // API-key blob, never the webhook one).
    const sealedCredentials = sealCredentials(
      { keyId: "mock_pub_jobs", keySecret: "mock_secret_jobs" },
      paymentCredentialsAad(tenantA, "mock"),
    );
    const sealedWebhookSecret = sealCredentials(
      { webhookSecret: "mock_webhook_jobs" },
      paymentWebhookSecretAad(tenantA, "mock"),
    );
    await admin`
      INSERT INTO payment_accounts
        (id, tenant_id, provider_code, label, public_key_id,
         sealed_credentials, sealed_webhook_secret, credential_fingerprint, is_enabled)
      VALUES (${randomUUID()}, ${tenantA}, 'mock', 'Default', 'mock_pub_jobs',
              ${sealedCredentials}, ${sealedWebhookSecret},
              ${credentialFingerprint(sealedCredentials)}, true)
      ON CONFLICT DO NOTHING`;

    const orderId = await makePendingOrder(tenantA, {
      expiresOffsetMinutes: 60,
      status: "cancelled",
    });
    const paymentId = randomUUID();
    await admin`
      INSERT INTO payments
        (id, tenant_id, order_id, payment_account_id, provider_code, status,
         amount_paise, gateway_order_id, gateway_payment_id)
      VALUES (${paymentId}, ${tenantA}, ${orderId}, ${randomUUID()}, 'mock', 'captured',
              49900, ${"order_jobs_" + randomUUID().slice(0, 8)},
              ${"pay_jobs_" + randomUUID().slice(0, 8)})`;
    const refundId = randomUUID();
    await admin`
      INSERT INTO refunds (id, tenant_id, order_id, payment_id, amount_paise, status, reason)
      VALUES (${refundId}, ${tenantA}, ${orderId}, ${paymentId}, 49900, 'pending', 'merchant_cancelled')`;
    return { refundId, paymentId, orderId };
  }

  it("passes the refund id through as the gateway idempotency key and marks processing; replay no-ops", async () => {
    const { refundId } = await makeRefundFixture();

    const result = await processGatewayRefund({ tenantId: tenantA, refundId });
    expect(result.status).toBe("processing");

    // The mock driver mints rfnd_mock_<sha256(idempotencyKey)[:20]> — the
    // stored gateway id PROVES the refund id rode through as the key.
    const expected =
      "rfnd_mock_" + createHash("sha256").update(refundId, "utf8").digest("hex").slice(0, 20);
    expect(result.gatewayRefundId).toBe(expected);
    const [row] = await admin<Record<string, unknown>[]>`
      SELECT status, gateway_refund_id FROM refunds WHERE id = ${refundId}`;
    expect(row!.status).toBe("processing");
    expect(row!.gateway_refund_id).toBe(expected);

    // A retried job is a no-op — the intent already went out.
    const replay = await processGatewayRefund({ tenantId: tenantA, refundId });
    expect(replay.status).toBe("already_processing");
  });
});
