import { createHash, randomUUID } from "node:crypto";

import { closeRedis } from "@platform/core";
import { transitionOrder } from "@platform/core/orders/server";
import { closeConnections, withTenant } from "@platform/db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Console orders surface against real PostgreSQL: list/detail authz, the
 * full manual fulfilment ladder (D12/§4.8) including COD
 * paid-at-delivered, the 422 illegal-transition wall, the D21
 * concurrent-modification belt, the orders:cancel / orders:write
 * permission split, and newest-first timeline reads.
 *
 * Orders are created DIRECTLY by this suite — checkout orchestration is
 * B-INT's; the orders domain and console surface must stand alone over
 * rows that already exist (per the B5 lot contract). The customers-list
 * row of the test matrix belongs to B4 and is deliberately absent here.
 */

let sessionToken: string | undefined;

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "console_session" && sessionToken ? { name, value: sessionToken } : undefined,
    }),
  headers: () => Promise.resolve(new Headers()),
}));

const { GET: getOrdersRoute } = await import("../src/app/api/orders/route");
const { GET: getOrderDetailRoute } = await import("../src/app/api/orders/[id]/route");
const { POST: postTransitionRoute } = await import(
  "../src/app/api/orders/[id]/transition/route"
);
const { POST: postCancelRoute } = await import("../src/app/api/orders/[id]/cancel/route");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantId: string;
let ownerToken: string;
let ownerUserId: string;
let cashierToken: string; // orders:read + orders:write, NOT orders:cancel
let catalogToken: string; // catalog_manager: no orders permissions at all

const createdTenants = new Set<string>();
const createdUsers = new Set<string>();
const createdPlans = new Set<string>();

let nextOrderNumber = 5001;

async function makeSession(
  tenant: string,
  role: string,
): Promise<{ token: string; userId: string }> {
  const userId = randomUUID();
  createdUsers.add(userId);
  const phone = "+9197" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userId}, ${phone}, 'Orders route test')`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, role, accepted_at)
    VALUES (${tenant}, ${userId}, ${role}, now())`;
  const token = randomUUID() + randomUUID();
  await admin`
    INSERT INTO sessions (id, token_hash, user_id, tenant_id, expires_at, idle_expires_at)
    VALUES (${randomUUID()}, ${createHash("sha256").update(token).digest("hex")},
            ${userId}, ${tenant}, now() + interval '1 day', now() + interval '1 day')`;
  return { token, userId };
}

/**
 * Insert an order directly, honoring the D16 CHECK
 * (total = subtotal − discount + shipping).
 */
async function makeOrder(opts: {
  status?: string;
  paymentMode?: string;
  paymentStatus?: string;
  subtotalPaise?: number;
  shippingPaise?: number;
  amountPaidPaise?: number;
  codDuePaise?: number;
  buyerName?: string;
}): Promise<{ id: string; orderNumber: number; totalPaise: number }> {
  const id = randomUUID();
  const orderNumber = nextOrderNumber++;
  const subtotal = opts.subtotalPaise ?? 99900;
  const shipping = opts.shippingPaise ?? 0;
  const total = subtotal + shipping;
  const address = JSON.stringify({
    line1: "1 Test Lane",
    city: "Bengaluru",
    state_code: "29",
    pincode: "560001",
  });
  await admin`
    INSERT INTO orders
      (id, tenant_id, order_number, status, payment_status, payment_mode,
       buyer_name, buyer_phone_e164, shipping_address, place_of_supply,
       subtotal_paise, discount_paise, shipping_paise, tax_paise, total_paise,
       amount_paid_paise, cod_due_paise)
    VALUES
      (${id}, ${tenantId}, ${orderNumber}, ${opts.status ?? "confirmed"},
       ${opts.paymentStatus ?? "paid"}, ${opts.paymentMode ?? "prepaid"},
       ${opts.buyerName ?? "Asha Test"}, '+919600000001', ${address}::text::jsonb, '29',
       ${subtotal}, 0, ${shipping}, ${Math.round((subtotal * 1800) / 11800)}, ${total},
       ${opts.amountPaidPaise ?? total}, ${opts.codDuePaise ?? 0})`;
  return { id, orderNumber, totalPaise: total };
}

async function getList(query = ""): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await getOrdersRoute(
    new Request(`http://console.test/api/orders${query}`, { method: "GET" }),
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function getDetail(id: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await getOrderDetailRoute(
    new Request(`http://console.test/api/orders/${id}`, { method: "GET" }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function postTransition(
  id: string,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await postTransitionRoute(
    new Request(`http://console.test/api/orders/${id}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function postCancel(
  id: string,
  body: unknown = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await postCancelRoute(
    new Request(`http://console.test/api/orders/${id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function orderRow(id: string): Promise<{
  status: string;
  payment_status: string;
  amount_paid_paise: number;
  cod_due_paise: number;
}> {
  const [row] = await admin<
    { status: string; payment_status: string; amount_paid_paise: string; cod_due_paise: string }[]
  >`SELECT status, payment_status, amount_paid_paise, cod_due_paise FROM orders WHERE id = ${id}`;
  return {
    status: row!.status,
    payment_status: row!.payment_status,
    amount_paid_paise: Number(row!.amount_paid_paise),
    cod_due_paise: Number(row!.cod_due_paise),
  };
}

beforeAll(async () => {
  const slug = "ordr-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"ordr-" + randomUUID().slice(0, 8)}, 'Orders route plan')
    RETURNING id`;
  createdPlans.add(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  tenantId = tenant!.id;
  createdTenants.add(tenantId);

  const owner = await makeSession(tenantId, "owner");
  ownerToken = owner.token;
  ownerUserId = owner.userId;
  cashierToken = (await makeSession(tenantId, "cashier")).token;
  catalogToken = (await makeSession(tenantId, "catalog_manager")).token;
});

afterEach(() => {
  sessionToken = undefined;
});

afterAll(async () => {
  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdUsers) await admin`DELETE FROM users WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  // The manual-transition door enqueues its domain event after commit;
  // that lazily opened the shared Redis client. Close it or vitest hangs.
  await closeRedis().catch(() => undefined);
  await closeConnections();
});

describe("GET /api/orders (list)", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const { status } = await getList();
    expect(status).toBe(401);
  });

  it("refuses a role without orders:read with 403, on both list and detail", async () => {
    const order = await makeOrder({});
    sessionToken = catalogToken;
    expect((await getList()).status).toBe(403);
    expect((await getDetail(order.id)).status).toBe(403);
  });

  it("lists orders newest-first, filters by status, refuses an unknown status", async () => {
    const confirmed = await makeOrder({ status: "confirmed", buyerName: "Filter Confirmed" });
    const shipped = await makeOrder({ status: "shipped", buyerName: "Filter Shipped" });

    sessionToken = ownerToken;
    const all = await getList();
    expect(all.status).toBe(200);
    const items = all.data.items as { id: string; placedAt: string }[];
    const ids = items.map((i) => i.id);
    expect(ids).toContain(confirmed.id);
    expect(ids).toContain(shipped.id);
    // Newest-first: every listed row's placedAt is non-increasing.
    const placed = items.map((i) => i.placedAt);
    const sorted = [...placed].sort((a, b) => (a < b ? 1 : -1));
    expect(placed).toEqual(sorted);

    const filtered = await getList("?status=shipped");
    expect(filtered.status).toBe(200);
    const filteredIds = (filtered.data.items as { id: string }[]).map((i) => i.id);
    expect(filteredIds).toContain(shipped.id);
    expect(filteredIds).not.toContain(confirmed.id);

    const bad = await getList("?status=teleported");
    expect(bad.status).toBe(422);
    expect((bad.data.error as { code: string }).code).toBe("invalid_payload");
  });
});

describe("GET /api/orders/[id] (detail)", () => {
  it("404s a malformed id and an unknown id", async () => {
    sessionToken = ownerToken;
    expect((await getDetail("not-a-uuid")).status).toBe(404);
    expect((await getDetail(randomUUID())).status).toBe(404);
  });

  it("returns snapshot lines, totals and the timeline newest-first", async () => {
    const order = await makeOrder({ status: "confirmed", subtotalPaise: 99900 });
    await admin`
      INSERT INTO order_lines
        (id, tenant_id, order_id, kind, title_snapshot, sku_snapshot, quantity,
         unit_price_paise, taxable_paise, tax_rate_bps, cgst_paise, sgst_paise, igst_paise,
         tax_paise, total_paise, position)
      VALUES
        (${randomUUID()}, ${tenantId}, ${order.id}, 'item', 'Cotton shirt', 'SHIRT-M', 1,
         99900, 84661, 1800, 7620, 7619, 0, 15239, 99900, 0),
        (${randomUUID()}, ${tenantId}, ${order.id}, 'shipping', 'Shipping', '', 1,
         0, 0, 1800, 0, 0, 0, 0, 0, 1)`;
    // Two timeline rows a minute apart — the read must return the newer first.
    await admin`
      INSERT INTO order_events
        (id, tenant_id, order_id, event, from_status, to_status, actor_type, created_at)
      VALUES
        (${randomUUID()}, ${tenantId}, ${order.id}, 'order.placed', NULL, 'pending_payment',
         'customer', now() - interval '1 minute'),
        (${randomUUID()}, ${tenantId}, ${order.id}, 'order.confirmed', 'pending_payment',
         'confirmed', 'system', now())`;

    sessionToken = ownerToken;
    const { status, data } = await getDetail(order.id);
    expect(status).toBe(200);
    expect(data.orderNumber).toBe(order.orderNumber);
    expect(data.totalPaise).toBe(order.totalPaise);

    const lines = data.lines as { kind: string; titleSnapshot: string; taxPaise: number }[];
    expect(lines.length).toBe(2);
    expect(lines[0]!.kind).toBe("item");
    expect(lines[0]!.taxPaise).toBe(15239);
    expect(lines[1]!.kind).toBe("shipping");

    const events = data.events as { event: string }[];
    expect(events.map((e) => e.event)).toEqual(["order.confirmed", "order.placed"]);
  });
});

describe("POST /api/orders/[id]/transition (manual ladder, D12/§4.8)", () => {
  it("refuses a role without orders:write with 403, moving nothing", async () => {
    const order = await makeOrder({ status: "confirmed" });
    sessionToken = catalogToken;
    const { status } = await postTransition(order.id, { to: "processing" });
    expect(status).toBe(403);
    expect((await orderRow(order.id)).status).toBe("confirmed");
  });

  it("walks the full ladder to delivered, writing an order_events and audit row per step", async () => {
    const order = await makeOrder({ status: "confirmed" });
    sessionToken = ownerToken;

    const ladder = ["processing", "ready_to_ship", "shipped", "out_for_delivery", "delivered"];
    for (const to of ladder) {
      const { status, data } = await postTransition(order.id, { to });
      expect(status, `→ ${to}`).toBe(200);
      expect((data as { orderId: string }).orderId).toBe(order.id);
      expect((await orderRow(order.id)).status).toBe(to);
    }

    const events = await admin<
      { event: string; from_status: string; to_status: string; actor_type: string }[]
    >`SELECT event, from_status, to_status, actor_type FROM order_events
      WHERE order_id = ${order.id} ORDER BY created_at, id`;
    expect(events.map((e) => e.event)).toEqual([
      "order.processing",
      "order.ready_to_ship",
      "order.shipped",
      "order.out_for_delivery",
      "order.delivered",
    ]);
    expect(events.map((e) => `${e.from_status}→${e.to_status}`)).toEqual([
      "confirmed→processing",
      "processing→ready_to_ship",
      "ready_to_ship→shipped",
      "shipped→out_for_delivery",
      "out_for_delivery→delivered",
    ]);
    expect(events.every((e) => e.actor_type === "staff")).toBe(true);

    const [audits] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE tenant_id = ${tenantId} AND action = 'order.status_changed'
        AND entity_id = ${order.id} AND actor_user_id = ${ownerUserId}`;
    expect(audits!.n).toBe(5);
  });

  it("delivering a COD order collects at the doorstep: paid, amount_paid = total (§4.8)", async () => {
    const order = await makeOrder({
      status: "out_for_delivery",
      paymentMode: "cod",
      paymentStatus: "pending",
      amountPaidPaise: 0,
      codDuePaise: 99900,
    });
    sessionToken = ownerToken;
    const { status } = await postTransition(order.id, { to: "delivered" });
    expect(status).toBe(200);
    const row = await orderRow(order.id);
    expect(row.status).toBe("delivered");
    expect(row.payment_status).toBe("paid");
    expect(row.amount_paid_paise).toBe(order.totalPaise);
    expect(row.cod_due_paise).toBe(0);
  });

  it("leaves a delivered prepaid order's payment fields alone", async () => {
    const order = await makeOrder({ status: "out_for_delivery", paymentMode: "prepaid" });
    sessionToken = ownerToken;
    const { status } = await postTransition(order.id, { to: "delivered" });
    expect(status).toBe(200);
    const row = await orderRow(order.id);
    expect(row.payment_status).toBe("paid");
    expect(row.amount_paid_paise).toBe(order.totalPaise);
  });

  it("refuses an illegal transition with 422 invalid_transition naming from, to and allowed", async () => {
    const order = await makeOrder({ status: "confirmed" });
    sessionToken = ownerToken;
    const { status, data } = await postTransition(order.id, { to: "shipped" });
    expect(status).toBe(422);
    const error = data.error as {
      code: string;
      details: { from: string; to: string; allowed: string[] };
    };
    expect(error.code).toBe("invalid_transition");
    expect(error.details.from).toBe("confirmed");
    expect(error.details.to).toBe("shipped");
    expect(error.details.allowed).toEqual(["processing"]);
    expect((await orderRow(order.id)).status).toBe("confirmed");
    const [events] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM order_events WHERE order_id = ${order.id}`;
    expect(events!.n).toBe(0);
  });

  it("refuses a target outside the manual allowlist at the payload gate (422)", async () => {
    const order = await makeOrder({ status: "confirmed" });
    sessionToken = ownerToken;
    // 'cancelled' is a legal TABLE edge from confirmed, but cancel has its
    // own route and permission — the transition payload cannot name it.
    const { status, data } = await postTransition(order.id, { to: "cancelled" });
    expect(status).toBe(422);
    expect((data.error as { code: string }).code).toBe("invalid_payload");
    expect((await orderRow(order.id)).status).toBe("confirmed");
  });

  it("returns 409 concurrent_modification when the order left the seen status (D21 belt)", async () => {
    const order = await makeOrder({ status: "processing" });
    // Call the write door directly with a STALE snapshot (as a racing
    // request would hold after its FOR UPDATE read was overtaken).
    let thrown: unknown;
    try {
      await withTenant(tenantId, (tx) =>
        transitionOrder(
          tx,
          { tenantId, actorType: "staff", actorUserId: ownerUserId },
          { id: order.id, status: "confirmed" }, // stale: the row is 'processing'
          "processing",
          { name: "order.processing" },
        ),
      );
    } catch (err) {
      thrown = err;
    }
    const appError = thrown as { code?: string; status?: number };
    expect(appError.code).toBe("concurrent_modification");
    expect(appError.status).toBe(409);
    const [events] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM order_events WHERE order_id = ${order.id}`;
    expect(events!.n).toBe(0);
  });
});

describe("POST /api/orders/[id]/cancel (permission split)", () => {
  it("splits orders:cancel from orders:write: a cashier may fulfil but not cancel", async () => {
    const order = await makeOrder({ status: "confirmed" });
    sessionToken = cashierToken;

    // Fulfilment works: cashier holds orders:write…
    const moved = await postTransition(order.id, { to: "processing" });
    expect(moved.status).toBe(200);

    // …but cancel is refused before any work happens.
    const cancelled = await postCancel(order.id, { reason: "buyer asked" });
    expect(cancelled.status).toBe(403);
    expect((await orderRow(order.id)).status).toBe("processing");
  });

  it("admits a holder of orders:cancel past the permission gate", async () => {
    const order = await makeOrder({ status: "confirmed" });
    sessionToken = ownerToken;
    const { status } = await postCancel(order.id, { reason: "test cancel" });
    // The cancel orchestration itself is B-INT's (checkout/server
    // cancelOrder); this suite pins only the B5 surface: the permission
    // gate must pass. Until B-INT lands the stub 500s; after it lands
    // this is a 200 — both prove the gate opened.
    expect([401, 403]).not.toContain(status);
  });
});
