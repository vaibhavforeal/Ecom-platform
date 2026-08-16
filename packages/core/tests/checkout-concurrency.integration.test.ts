import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeConnections, withTenant } from "@platform/db";
import { closeRedis, sealCredentials, credentialFingerprint } from "@platform/core";
import { upsertLine } from "@platform/core/cart/server";
import {
  confirmFromWebhookEvent,
  setGatewayAdapterResolver,
  startCheckout,
} from "@platform/core/checkout/server";
import type { CheckoutPayload } from "@platform/core/checkout";
import { allocateInvoiceNumber } from "@platform/core/invoices/server";
import { recordMovement } from "@platform/core/inventory/server";
import type { GatewayEvent, PaymentGatewayAdapter } from "@platform/core/payments";
import {
  paymentCredentialsAad,
  paymentWebhookSecretAad,
  recordWebhookEvent,
} from "@platform/core/payments/server";
import { claimRedemption, loadActivePromotionForUpdate } from "@platform/core/promotions/server";

/**
 * The races (spec §9): concurrent confirms and gap-free invoice
 * numbering, the coupon slot under contention, the D8 advisory at
 * cap−1, and the two D2a oversold variants — the last-unit steal
 * (insufficient_stock) and the held remainder (stock_held) — both
 * cancelling with an insert-once refund, no invoice, no redemption,
 * zero sale movements.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 4, onnotice: () => {} });

let tenantA: string;
let userA: string;
let locationA: string;
let planId: string;

const savedEnv = new Map<string, string | undefined>();
let purgeServer: Server;

const fakeAdapter: PaymentGatewayAdapter = {
  provider: "mock",
  async createGatewayOrder(_creds, args) {
    return {
      gatewayOrderId:
        "order_conc_" + createHash("sha256").update(args.receipt, "utf8").digest("hex").slice(0, 16),
    };
  },
  verifyWebhook: () => true,
  parseWebhook: () => {
    throw new Error("unused");
  },
  async refund(_creds, args) {
    return { gatewayRefundId: "rfnd_conc_" + args.idempotencyKey.slice(0, 8) };
  },
};

function ctx() {
  return { tenantId: tenantA, requestId: "checkout-conc" };
}

function writeCtx() {
  return { tenantId: tenantA, actorUserId: userA, ip: null, userAgent: null, requestId: "checkout-conc" };
}

let phoneCounter = 0;
function freshPhone(): string {
  phoneCounter += 1;
  return "+9198991" + String(phoneCounter).padStart(4, "0");
}

function payload(overrides: Partial<CheckoutPayload> = {}): CheckoutPayload {
  return {
    idempotencyKey: randomUUID(),
    buyerName: "Concurrency Tester",
    phone: freshPhone(),
    email: null,
    shippingAddress: {
      line1: "42 Race Lane",
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

async function makeVariant(opts: { pricePaise?: number } = {}): Promise<string> {
  const [product] = await admin<{ id: string }[]>`
    INSERT INTO products (id, tenant_id, title, status, hsn_code, tax_rate_bps, published_at)
    VALUES (${randomUUID()}, ${tenantA}, ${"Race product " + randomUUID().slice(0, 8)},
            'active', '6109', 1800, now())
    RETURNING id`;
  const [variant] = await admin<{ id: string }[]>`
    INSERT INTO product_variants
      (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory)
    VALUES (${randomUUID()}, ${tenantA}, ${product!.id}, ${"CONC-" + randomUUID().slice(0, 8)},
            ${opts.pricePaise ?? 49900}, 100, true)
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
  effects: unknown[];
  usageLimitTotal?: number | null;
}): Promise<{ id: string; code: string }> {
  const code = "RACE" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO promotions
      (id, tenant_id, code, name, status, conditions, effects, usage_limit_total)
    VALUES (${randomUUID()}, ${tenantA}, ${code}, ${code}, 'active',
            ${"[]"}::text::jsonb, ${JSON.stringify(opts.effects)}::text::jsonb,
            ${opts.usageLimitTotal ?? null})
    RETURNING id`;
  return { id: row!.id, code };
}

async function orderRow(orderId: string) {
  const [row] = await admin<Record<string, unknown>[]>`SELECT * FROM orders WHERE id = ${orderId}`;
  return row!;
}

async function pendingPrepaid(
  variantId: string,
  quantity = 1,
): Promise<{ orderId: string; gatewayOrderId: string; amountPaise: number }> {
  const res = await startCheckout(ctx(), await makeCart([{ variantId, quantity }]), payload());
  if (res.status !== "payment_required") throw new Error("expected payment_required");
  return { orderId: res.orderId, gatewayOrderId: res.gatewayOrderId, amountPaise: res.amountPaise };
}

function capture(gatewayOrderId: string, amountPaise: number): GatewayEvent {
  return {
    eventId: "evt_conc_" + randomUUID(),
    type: "payment.captured",
    gatewayOrderId,
    gatewayPaymentId: "pay_conc_" + randomUUID().slice(0, 12),
    amountPaise,
    method: "upi",
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(25);
  }
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
  process.env.SESSION_SECRET ??= "checkout-conc-secret-00000000000000000000000000000";
  process.env.CREDENTIALS_MASTER_KEY ??= randomBytes(32).toString("base64");

  purgeServer = createServer((_req, res) => {
    res.statusCode = 200;
    res.end("{}");
  });
  await new Promise<void>((resolve) => purgeServer.listen(0, "127.0.0.1", resolve));
  process.env.STOREFRONT_INTERNAL_ORIGIN = `http://127.0.0.1:${(purgeServer.address() as { port: number }).port}`;
  process.env.INTERNAL_API_SECRET = "checkout-conc-internal";

  setGatewayAdapterResolver(() => fakeAdapter);

  const slug = "conc-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"conc-" + randomUUID().slice(0, 8)}, 'Concurrency test plan')
    RETURNING id`;
  planId = plan!.id;
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants
      (id, slug, legal_name, display_name, plan_id, status,
       tax_registration_type, gstin, origin_state_code)
    VALUES (${randomUUID()}, ${slug}, 'Concurrency Sellers Pvt Ltd', ${slug}, ${plan!.id},
            'active', 'regular', '29ABCDE1234F1Z6', '29')
    RETURNING id`;
  tenantA = tenant!.id;

  userA = randomUUID();
  const phone = "+9197" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userA}, ${phone}, 'Conc tester')`;

  const [loc] = await admin<{ id: string }[]>`
    INSERT INTO locations (id, tenant_id, name, is_default)
    VALUES (${randomUUID()}, ${tenantA}, 'Default', true)
    RETURNING id`;
  locationA = loc!.id;

  const sealedCredentials = sealCredentials(
    { keyId: "mock_pub_conc", keySecret: "mock_secret_conc" },
    paymentCredentialsAad(tenantA, "mock"),
  );
  const sealedWebhookSecret = sealCredentials(
    { webhookSecret: "mock_webhook_conc" },
    paymentWebhookSecretAad(tenantA, "mock"),
  );
  await admin`
    INSERT INTO payment_accounts
      (id, tenant_id, provider_code, label, public_key_id,
       sealed_credentials, sealed_webhook_secret, credential_fingerprint, is_enabled)
    VALUES (${randomUUID()}, ${tenantA}, 'mock', 'Default', 'mock_pub_conc',
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

describe("invoice numbering under contention", () => {
  it("two concurrent webhook confirms allocate DISTINCT consecutive invoice numbers", async () => {
    const variant = await makeVariant();
    await seed(variant, 10);
    const a = await pendingPrepaid(variant);
    const b = await pendingPrepaid(variant);

    await Promise.all([
      deliver(capture(a.gatewayOrderId, a.amountPaise)),
      deliver(capture(b.gatewayOrderId, b.amountPaise)),
    ]);

    const rows = await admin<{ number: number; order_id: string }[]>`
      SELECT number::int, order_id FROM invoices
      WHERE tenant_id = ${tenantA} AND order_id IN (${a.orderId}, ${b.orderId})
      ORDER BY number`;
    expect(rows.length).toBe(2);
    expect(rows[0]!.number).not.toBe(rows[1]!.number);
    expect(rows[1]!.number).toBe(rows[0]!.number + 1);
  });

  it("a forced failure AFTER allocation returns the number — the series stays gap-free", async () => {
    const fy = "2098-99"; // a fenced-off series this test owns entirely
    let allocated = 0;
    await withTenant(tenantA, async (tx) => {
      const first = await allocateInvoiceNumber(tx, tenantA, {
        seriesCode: "INV",
        financialYear: fy,
        prefix: "INV",
      });
      allocated = first.number;
      throw new Error("forced rollback after allocation");
    }).catch((err: unknown) => {
      if (!(err instanceof Error) || err.message !== "forced rollback after allocation") throw err;
    });

    const again = await withTenant(tenantA, (tx) =>
      allocateInvoiceNumber(tx, tenantA, { seriesCode: "INV", financialYear: fy, prefix: "INV" }),
    );
    expect(again.number).toBe(allocated); // the rolled-back number came back
  });
});

describe("coupon slots under contention", () => {
  it("two concurrent claims on the last slot never mint two redemption rows", async () => {
    const promo = await makePromotion({
      effects: [{ type: "flat_off", paise: 500 }],
      usageLimitTotal: 1,
    });
    const orderA = randomUUID();
    const orderB = randomUUID();

    const claim = (orderId: string) =>
      withTenant(tenantA, async (tx) => {
        const data = await loadActivePromotionForUpdate(tx, tenantA, promo.code);
        if (!data) throw new Error("promotion vanished");
        return claimRedemption(tx, tenantA, {
          promotion: data,
          orderId,
          customerId: null,
          discountPaise: 500,
        });
      });

    const outcomes = await Promise.allSettled([claim(orderA), claim(orderB)]);
    const claimedCount = outcomes.filter(
      (o) => o.status === "fulfilled" && o.value.claimed === true,
    ).length;
    // One claims; the other refuses at the count (serialized by the FOR
    // UPDATE) or 409s on the slot index — never a second row.
    expect(claimedCount).toBe(1);
    const rows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM coupon_redemptions WHERE promotion_id = ${promo.id}`;
    expect(rows[0]!.n).toBe(1);
  });

  it("re-claiming for the SAME order replays the original slot (webhook redelivery shape)", async () => {
    const promo = await makePromotion({
      effects: [{ type: "flat_off", paise: 500 }],
      usageLimitTotal: 5,
    });
    const orderId = randomUUID();
    const claimOnce = () =>
      withTenant(tenantA, async (tx) => {
        const data = (await loadActivePromotionForUpdate(tx, tenantA, promo.code))!;
        return claimRedemption(tx, tenantA, {
          promotion: data,
          orderId,
          customerId: null,
          discountPaise: 500,
        });
      });
    const first = await claimOnce();
    const second = await claimOnce();
    if (!first.claimed || !second.claimed) throw new Error("expected claims");
    expect(second.redemptionId).toBe(first.redemptionId);
    expect(second.slot).toBe(first.slot);
  });

  it("checkout-start advisory is serialized at cap−1: exactly ONE of two concurrent starts wins (D8)", async () => {
    const promo = await makePromotion({
      effects: [{ type: "flat_off", paise: 500 }],
      usageLimitTotal: 1,
    });
    const variant = await makeVariant();
    await seed(variant, 10);
    const cartA = await makeCart([{ variantId: variant, quantity: 1 }]);
    const cartB = await makeCart([{ variantId: variant, quantity: 1 }]);

    const outcomes = await Promise.allSettled([
      startCheckout(ctx(), cartA, payload({ couponCode: promo.code })),
      startCheckout(ctx(), cartB, payload({ couponCode: promo.code })),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const refused = outcomes.filter(
      (o) => o.status === "rejected" && (o.reason as { code?: string }).code === "coupon_exhausted",
    );
    expect(fulfilled.length).toBe(1);
    expect(refused.length).toBe(1);

    const claims = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM orders
      WHERE tenant_id = ${tenantA} AND promotion_id = ${promo.id} AND status = 'pending_payment'`;
    expect(claims[0]!.n).toBe(1);
  });

  it("an EXPIRED pending claim stops counting against the advisory (read-side filter)", async () => {
    const promo = await makePromotion({
      effects: [{ type: "flat_off", paise: 500 }],
      usageLimitTotal: 1,
    });
    const variant = await makeVariant();
    await seed(variant, 10);

    const first = await startCheckout(
      ctx(),
      await makeCart([{ variantId: variant, quantity: 1 }]),
      payload({ couponCode: promo.code }),
    );
    // The pending claim lapses — readers must stop counting it NOW, no
    // sweeper required.
    await admin`
      UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${first.orderId}`;

    const second = await startCheckout(
      ctx(),
      await makeCart([{ variantId: variant, quantity: 1 }]),
      payload({ couponCode: promo.code }),
    );
    expect(second.status).toBe("payment_required");
  });
});

describe("the D2a oversold paths", () => {
  async function assertOversold(orderId: string, amountPaise: number): Promise<void> {
    const order = await orderRow(orderId);
    expect(order.status).toBe("cancelled");
    expect(order.cancel_reason).toBe("stock_shortfall");
    expect(order.payment_status).toBe("refund_initiated");
    expect(Number(order.amount_paid_paise)).toBe(amountPaise);

    // Money captured, refund intent inserted ONCE, no invoice, no
    // redemption, zero sale movements — the TX-2 rollback was total.
    const paymentRows = await admin<{ status: string; id: string }[]>`
      SELECT status, id FROM payments WHERE order_id = ${orderId}`;
    expect(paymentRows.length).toBe(1);
    expect(paymentRows[0]!.status).toBe("captured");
    const refundRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM refunds WHERE order_id = ${orderId}`;
    expect(refundRows[0]!.n).toBe(1);
    const invoiceRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM invoices WHERE order_id = ${orderId}`;
    expect(invoiceRows[0]!.n).toBe(0);
    const movementRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stock_movements
      WHERE reference_type = 'checkout' AND reference_id = ${orderId} AND reason = 'sale'`;
    expect(movementRows[0]!.n).toBe(0);
    const eventRows = await admin<{ event: string }[]>`
      SELECT event FROM order_events WHERE order_id = ${orderId}`;
    expect(eventRows.map((r) => r.event)).toContain("order.oversold");
    expect(eventRows.map((r) => r.event)).toContain("payment.refund_initiated");
  }

  it("last-unit steal (insufficient_stock): capture cancels + refunds, order money-safe", async () => {
    const variant = await makeVariant();
    await seed(variant, 1);
    const a = await pendingPrepaid(variant);

    // A's hold lapses; a COD buyer takes the last unit through the front
    // door (hold + consume).
    await admin`
      UPDATE stock_reservations SET expires_at = now() - interval '1 minute'
      WHERE reference_type = 'checkout' AND reference_id = ${a.orderId}`;
    const codRes = await startCheckout(
      ctx(),
      await makeCart([{ variantId: variant, quantity: 1 }]),
      payload({ paymentMode: "cod" }),
    );
    expect(codRes.status).toBe("confirmed");

    // The late capture for A arrives — TX-2 rolls back on the CHECK, TX-3
    // cancels + refunds.
    await deliver(capture(a.gatewayOrderId, a.amountPaise));
    await assertOversold(a.orderId, a.amountPaise);
  });

  it("stock_held variant: the remainder is held by ANOTHER checkout — same cancel + refund path (D2a)", async () => {
    const variant = await makeVariant();
    await seed(variant, 1);
    const a = await pendingPrepaid(variant);

    // A's hold lapses, and a competitor's ACTIVE hold claims the unit.
    await admin`
      UPDATE stock_reservations SET expires_at = now() - interval '1 minute'
      WHERE reference_type = 'checkout' AND reference_id = ${a.orderId}`;
    await admin`
      INSERT INTO stock_reservations
        (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
      VALUES (${randomUUID()}, ${tenantA}, ${variant}, ${locationA}, 1,
              'checkout', ${randomUUID()}, now() + interval '15 minutes')`;

    await deliver(capture(a.gatewayOrderId, a.amountPaise));
    await assertOversold(a.orderId, a.amountPaise);
    // The stock itself was never consumed — the held unit is intact.
    const [level] = await admin<{ on_hand: number }[]>`
      SELECT on_hand::int FROM stock_levels WHERE tenant_id = ${tenantA} AND variant_id = ${variant}`;
    expect(level!.on_hand).toBe(1);
  });

  it("redelivering the capture after an oversold cancel stays idempotent: still ONE refund row", async () => {
    const variant = await makeVariant();
    await seed(variant, 1);
    const a = await pendingPrepaid(variant);
    await admin`
      UPDATE stock_reservations SET expires_at = now() - interval '1 minute'
      WHERE reference_type = 'checkout' AND reference_id = ${a.orderId}`;
    await admin`
      INSERT INTO stock_reservations
        (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
      VALUES (${randomUUID()}, ${tenantA}, ${variant}, ${locationA}, 1,
              'checkout', ${randomUUID()}, now() + interval '15 minutes')`;

    const event = capture(a.gatewayOrderId, a.amountPaise);
    await deliver(event);
    // Redelivery: same event id → deduped evidence; processing no-ops on
    // the captured payment.
    await deliver(event);
    // And a DIFFERENT event id for the same capture (gateway quirk) still
    // resolves on the refunds UNIQUE.
    await deliver({ ...capture(a.gatewayOrderId, a.amountPaise), gatewayPaymentId: undefined });

    const refundRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM refunds WHERE order_id = ${a.orderId}`;
    expect(refundRows[0]!.n).toBe(1);
    const order = await orderRow(a.orderId);
    expect(order.status).toBe("cancelled");
  });
});

describe("confirm-time races", () => {
  it("two concurrent deliveries of the SAME capture: one confirmation, one replay", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const a = await pendingPrepaid(variant);
    const event = capture(a.gatewayOrderId, a.amountPaise);

    // Both deliveries race the full route shape (TX-1 dedupe + TX-2).
    const outcomes = await Promise.allSettled([deliver(event), deliver(event)]);
    // At least one must succeed; a loser MAY surface 409
    // concurrent_modification (the D21 belt) and ride redelivery.
    expect(outcomes.some((o) => o.status === "fulfilled")).toBe(true);

    const order = await orderRow(a.orderId);
    expect(order.status).toBe("confirmed");
    const invoiceRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM invoices WHERE order_id = ${a.orderId}`;
    expect(invoiceRows[0]!.n).toBe(1);
    const movementRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stock_movements
      WHERE reference_type = 'checkout' AND reference_id = ${a.orderId} AND reason = 'sale'`;
    expect(movementRows[0]!.n).toBe(1);
    expect(Number(order.amount_paid_paise)).toBe(a.amountPaise);
  });

  it("concurrent confirms of DIFFERENT orders sharing variants do not deadlock (sorted lock order)", async () => {
    const v1 = await makeVariant();
    const v2 = await makeVariant();
    await seed(v1, 10);
    await seed(v2, 10);

    // Opposite line orders — the sorted-id lock discipline is what keeps
    // this from deadlocking.
    const a = await startCheckout(
      ctx(),
      await makeCart([
        { variantId: v1, quantity: 1 },
        { variantId: v2, quantity: 1 },
      ]),
      payload(),
    );
    const b = await startCheckout(
      ctx(),
      await makeCart([
        { variantId: v2, quantity: 1 },
        { variantId: v1, quantity: 1 },
      ]),
      payload(),
    );
    if (a.status !== "payment_required" || b.status !== "payment_required") {
      throw new Error("expected payment_required");
    }

    await Promise.all([
      deliver(capture(a.gatewayOrderId, a.amountPaise)),
      deliver(capture(b.gatewayOrderId, b.amountPaise)),
    ]);
    expect((await orderRow(a.orderId)).status).toBe("confirmed");
    expect((await orderRow(b.orderId)).status).toBe("confirmed");
  });

  it("concurrent same-key replays keep ONE hold set (replace semantics) and one order", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const p = payload();
    const first = await startCheckout(ctx(), cartId, p);

    const replays = await Promise.all([
      startCheckout(ctx(), cartId, p),
      startCheckout(ctx(), cartId, p),
    ]);
    for (const r of replays) expect(r.orderId).toBe(first.orderId);

    const holds = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stock_reservations
      WHERE reference_type = 'checkout' AND reference_id = ${first.orderId}`;
    expect(holds[0]!.n).toBe(1);
    const orderRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM orders
      WHERE tenant_id = ${tenantA} AND idempotency_key = ${p.idempotencyKey}`;
    expect(orderRows[0]!.n).toBe(1);
  });
});

describe("replay and lock-order races (review fixes)", () => {
  it("concurrent replays during payment-start surface ONE gateway order ref — a capture can never be stranded", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const p = payload();

    // A Razorpay-shaped adapter: a UNIQUE gateway order per call (no
    // receipt dedupe — the mock's dedupe is what used to hide this bug),
    // with each call parked on a gate this test controls.
    let mints = 0;
    const gates: Array<() => void> = [];
    const gatedAdapter: PaymentGatewayAdapter = {
      provider: "mock",
      async createGatewayOrder() {
        mints += 1;
        const seq = mints;
        await new Promise<void>((resolve) => gates.push(resolve));
        return { gatewayOrderId: `order_race_${seq}_${randomUUID().slice(0, 8)}` };
      },
      verifyWebhook: () => true,
      parseWebhook: () => {
        throw new Error("unused");
      },
      async refund() {
        return { gatewayRefundId: "rfnd_unused" };
      },
    };
    setGatewayAdapterResolver(() => gatedAdapter);
    try {
      const winner = startCheckout(ctx(), cartId, p); // parks in mint #1, ref still NULL
      await waitFor(() => gates.length >= 1);
      const replay = startCheckout(ctx(), cartId, p); // ref still NULL → mints too, parks in #2
      await waitFor(() => gates.length >= 2);

      // The replay's mint resolves FIRST and stores its ref; the winner
      // resolves after — pre-fix the winner's TX-D overwrote the stored
      // ref with a gateway order the buyer was never shown, so the
      // capture webhook for the paid ref matched nothing.
      gates[1]!();
      const replayRes = await replay;
      gates[0]!();
      const winnerRes = await winner;
      if (winnerRes.status !== "payment_required" || replayRes.status !== "payment_required") {
        throw new Error("expected payment_required from both");
      }

      expect(mints).toBe(2); // the race was real: two gateway orders were minted
      expect(winnerRes.gatewayOrderId).toBe(replayRes.gatewayOrderId); // ONE ref surfaced
      const order = await orderRow(winnerRes.orderId);
      expect(order.gateway_order_ref).toBe(replayRes.gatewayOrderId);

      // The surfaced ref is backed by exactly one payments row, and its
      // capture confirms the order — no stranded money.
      const paymentRows = await admin<{ gateway_order_id: string }[]>`
        SELECT gateway_order_id FROM payments WHERE order_id = ${winnerRes.orderId}`;
      expect(paymentRows.length).toBe(1);
      expect(paymentRows[0]!.gateway_order_id).toBe(replayRes.gatewayOrderId);
      await deliver(capture(replayRes.gatewayOrderId, replayRes.amountPaise));
      expect((await orderRow(winnerRes.orderId)).status).toBe("confirmed");
    } finally {
      // On a failure path, unpark any still-gated adapter calls so the
      // dangling checkouts settle instead of outliving the test.
      for (const release of gates) release();
      setGatewayAdapterResolver(() => fakeAdapter);
    }
  });

  it("a same-key replay racing the confirm returns confirmed and leaves NO holds or TTL on the final order", async () => {
    const variant = await makeVariant();
    await seed(variant, 5);
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const p = payload();
    const start = await startCheckout(ctx(), cartId, p);
    if (start.status !== "payment_required") throw new Error("expected payment_required");

    // Simulate the webhook confirm committing mid-replay: an open admin
    // tx applies the confirm's row effects (status advanced, TTL
    // cleared, holds consumed) and holds the row locks while the replay
    // runs, so the replay serializes behind it exactly as it would
    // behind processCaptured's TX-2.
    let confirmed = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const confirmTx = admin.begin(async (sql) => {
      await sql`
        UPDATE orders SET status = 'confirmed', payment_status = 'paid',
          confirmed_at = now(), expires_at = NULL
        WHERE id = ${start.orderId}`;
      await sql`
        DELETE FROM stock_reservations
        WHERE reference_type = 'checkout' AND reference_id = ${start.orderId}`;
      confirmed = true;
      await gate;
    });
    await waitFor(() => confirmed);

    // The replay reads the stale pending status on its unlocked fast
    // path, then blocks on the locked rows; the "confirm" commits while
    // it waits.
    const replayPromise = startCheckout(ctx(), cartId, p);
    await sleep(400);
    release();
    await confirmTx;
    const replay = await replayPromise;

    // Pre-fix: payment_required, holds re-inserted, expires_at re-armed
    // on the confirmed order — 15 minutes of double-counted stock.
    expect(replay).toMatchObject({ orderId: start.orderId, status: "confirmed" });
    const order = await orderRow(start.orderId);
    expect(order.status).toBe("confirmed");
    expect(order.expires_at).toBeNull();
    const holds = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stock_reservations
      WHERE reference_type = 'checkout' AND reference_id = ${start.orderId}`;
    expect(holds[0]!.n).toBe(0);
  });

  it("checkout-start and the confirm path lock promotion → customer in the SAME order: no deadlock", async () => {
    const promo = await makePromotion({ effects: [{ type: "flat_off", paise: 500 }] });
    const variant = await makeVariant();
    await seed(variant, 5);
    const cartId = await makeCart([{ variantId: variant, quantity: 1 }]);
    const phone = freshPhone();
    await admin`
      INSERT INTO customers (id, tenant_id, phone_e164, name)
      VALUES (${randomUUID()}, ${tenantA}, ${phone}, 'Deadlock Tester')`;

    // The confirm side's exact lock order: promotion row FOR UPDATE
    // (claimRedemption), then the customer row (markFirstOrder) — held
    // open while a checkout for the same coupon + same buyer runs.
    let promotionLocked = false;
    let proceed!: () => void;
    const proceedGate = new Promise<void>((resolve) => (proceed = resolve));
    const confirmSideTx = admin.begin(async (sql) => {
      await sql`SELECT id FROM promotions WHERE id = ${promo.id} FOR UPDATE`;
      promotionLocked = true;
      await proceedGate;
      await sql`
        UPDATE customers SET updated_at = now()
        WHERE tenant_id = ${tenantA} AND phone_e164 = ${phone}`;
    });
    await waitFor(() => promotionLocked);

    // Post-fix the checkout parks on the promotion lock BEFORE touching
    // the customer row; pre-fix it already held the customer row (the
    // upsert) while waiting here — the classic inversion, and the
    // confirm side's customer UPDATE below then deadlocked (40P01).
    const checkoutPromise = startCheckout(ctx(), cartId, payload({ couponCode: promo.code, phone }));
    await sleep(400);
    proceed();
    await confirmSideTx; // pre-fix: one side dies with a deadlock here
    const res = await checkoutPromise;

    expect(res.status).toBe("payment_required");
    const order = await orderRow(res.orderId);
    expect(order.promotion_id).toBe(promo.id);
  });

  it("an add-to-cart racing checkout's cart conversion cannot slip a line onto the converted cart", async () => {
    const v1 = await makeVariant();
    const v2 = await makeVariant();
    await seed(v1, 5);
    await seed(v2, 5);
    const cartId = await makeCart([{ variantId: v1, quantity: 1 }]);

    // Simulate checkout's TX-A holding the cart row lock while it
    // snapshots the lines and converts the cart.
    let converted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const txA = admin.begin(async (sql) => {
      await sql`UPDATE carts SET status = 'converted' WHERE id = ${cartId}`;
      converted = true;
      await gate;
    });
    await waitFor(() => converted);

    // Pre-fix the plain status SELECT saw 'active', the line insert
    // landed, and only touchCart waited on the lock — the line survived
    // on the converted cart, silently absent from the snapshotted order.
    const attempt = upsertLine(ctx(), cartId, { variantId: v2, quantity: 1 });
    await sleep(400);
    release();
    await txA;
    await expect(attempt).rejects.toMatchObject({ code: "cart_not_active", status: 409 });
    const lines = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cart_lines WHERE cart_id = ${cartId} AND variant_id = ${v2}`;
    expect(lines[0]!.n).toBe(0);
  });
});
