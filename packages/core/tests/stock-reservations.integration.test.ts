import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { closeConnections, withTenant } from "@platform/db";
import {
  InsufficientAvailabilityError,
  VariantNotFoundError,
  consumeStock,
  getAvailability,
  getMovements,
  getStockLevels,
  holdStock,
  listInventory,
  recordMovement,
  reconcileStockLevels,
  releaseStock,
} from "@platform/core/inventory/server";

/**
 * The reservation primitive's invariants against real Postgres: holds
 * count only while unexpired, replace semantics, all-or-nothing refusal,
 * the last-unit race, consume's three outcomes, the stock_held guard
 * protecting OTHER references, and opportunistic GC.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantA: string;
let tenantB: string;
let userA: string;
let locationA: string;

const createdTenants = new Set<string>();
const createdUsers = new Set<string>();
const createdPlans = new Set<string>();

let purgeServer: Server;
let received: { tags: string[]; tenantId: string }[] = [];
let savedOrigin: string | undefined;
let savedSecret: string | undefined;

function ctx() {
  return { tenantId: tenantA, requestId: "resv-test" };
}

function writeCtx() {
  return { tenantId: tenantA, actorUserId: userA, ip: null, userAgent: null, requestId: "resv-test" };
}

function ref(): { type: string; id: string } {
  return { type: "checkout", id: randomUUID() };
}

async function makeTenant(): Promise<string> {
  const slug = "resv-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"resv-" + randomUUID().slice(0, 8)}, 'Reservations test plan')
    RETURNING id`;
  createdPlans.add(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  createdTenants.add(tenant!.id);
  return tenant!.id;
}

async function makeVariant(tenantId: string, tracked: boolean): Promise<string> {
  const [product] = await admin<{ id: string }[]>`
    INSERT INTO products (id, tenant_id, title, status)
    VALUES (${randomUUID()}, ${tenantId}, ${"resv-product-" + randomUUID().slice(0, 8)}, 'active')
    RETURNING id`;
  const [variant] = await admin<{ id: string }[]>`
    INSERT INTO product_variants
      (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory)
    VALUES
      (${randomUUID()}, ${tenantId}, ${product!.id}, ${"RESV-" + randomUUID().slice(0, 8)},
       19900, 500, ${tracked})
    RETURNING id`;
  return variant!.id;
}

/** Seed on-hand through the real write door so reconcile stays meaningful. */
async function seed(variantId: string, quantity: number): Promise<void> {
  await recordMovement(writeCtx(), { variantId, delta: quantity, note: "seed" });
}

async function insertHold(
  variantId: string,
  quantity: number,
  expiresOffsetSeconds: number,
  referenceId: string = randomUUID(),
): Promise<string> {
  await admin`
    INSERT INTO stock_reservations
      (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
    VALUES (${randomUUID()}, ${tenantA}, ${variantId}, ${locationA}, ${quantity},
            'checkout', ${referenceId}, now() + make_interval(secs => ${expiresOffsetSeconds}))`;
  return referenceId;
}

async function holdRows(referenceId: string): Promise<{ variant_id: string; quantity: number }[]> {
  return admin<{ variant_id: string; quantity: number }[]>`
    SELECT variant_id, quantity FROM stock_reservations
    WHERE reference_type = 'checkout' AND reference_id = ${referenceId}`;
}

async function variantHoldCount(variantId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_reservations WHERE variant_id = ${variantId}`;
  return row!.n;
}

async function saleCount(variantId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_movements
    WHERE variant_id = ${variantId} AND reason = 'sale'`;
  return row!.n;
}

async function availabilityOf(variantId: string) {
  return withTenant(tenantA, async (tx) => {
    const map = await getAvailability(tx, [variantId]);
    return map.get(variantId)!;
  });
}

beforeAll(async () => {
  tenantA = await makeTenant();
  tenantB = await makeTenant();
  userA = randomUUID();
  createdUsers.add(userA);
  const phone = "+9197" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userA}, ${phone}, 'Resv tester')`;

  const [loc] = await admin<{ id: string }[]>`
    INSERT INTO locations (id, tenant_id, name, is_default)
    VALUES (${randomUUID()}, ${tenantA}, 'Default', true)
    RETURNING id`;
  locationA = loc!.id;

  purgeServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      received.push(JSON.parse(body) as { tags: string[]; tenantId: string });
      res.statusCode = 200;
      res.end('{"purged":1}');
    });
  });
  await new Promise<void>((resolve) => purgeServer.listen(0, "127.0.0.1", resolve));
  const address = purgeServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  savedOrigin = process.env.STOREFRONT_INTERNAL_ORIGIN;
  savedSecret = process.env.INTERNAL_API_SECRET;
  process.env.STOREFRONT_INTERNAL_ORIGIN = `http://127.0.0.1:${port}`;
  process.env.INTERNAL_API_SECRET = "resv-purge-secret-4e71aa";
});

afterEach(() => {
  received = [];
});

afterAll(async () => {
  // Restore env BEFORE the pools close (the worker-suite lesson).
  if (savedOrigin === undefined) delete process.env.STOREFRONT_INTERNAL_ORIGIN;
  else process.env.STOREFRONT_INTERNAL_ORIGIN = savedOrigin;
  if (savedSecret === undefined) delete process.env.INTERNAL_API_SECRET;
  else process.env.INTERNAL_API_SECRET = savedSecret;
  await new Promise<void>((resolve) => purgeServer.close(() => resolve()));
  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdUsers) await admin`DELETE FROM users WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  await closeConnections();
});

describe("holdStock", () => {
  it("holds tracked lines, skips untracked; availability drops while on-hand stands", async () => {
    const vA = await makeVariant(tenantA, true);
    const vU = await makeVariant(tenantA, false);
    await seed(vA, 5);

    const reference = ref();
    const result = await holdStock(ctx(), {
      reference,
      lines: [
        { variantId: vA, quantity: 2 },
        { variantId: vU, quantity: 1 },
      ],
    });

    expect(result.lines).toEqual([
      { variantId: vA, quantity: 2, status: "held" },
      { variantId: vU, quantity: 1, status: "untracked" },
    ]);
    // expiresAt comes from Postgres now(); allow generous skew either way.
    const msOut = result.expiresAt.getTime() - Date.now();
    expect(msOut).toBeGreaterThan(13 * 60_000);
    expect(msOut).toBeLessThan(16 * 60_000);

    expect(await availabilityOf(vA)).toEqual({ onHand: 5, reserved: 2, available: 3 });
    const raw = await withTenant(tenantA, (tx) => getStockLevels(tx, [vA]));
    expect(raw.get(vA)).toBe(5); // on-hand untouched by a hold
    expect((await holdRows(reference.id)).length).toBe(1); // no row for the untracked line

    const released = await releaseStock(ctx(), reference);
    expect(released.released).toBe(1);
    expect(await availabilityOf(vA)).toEqual({ onHand: 5, reserved: 0, available: 5 });
  });

  it("an expired hold stops counting with no write anywhere", async () => {
    const vB = await makeVariant(tenantA, true);
    await seed(vB, 3);
    const reference = ref();
    await holdStock(ctx(), { reference, lines: [{ variantId: vB, quantity: 2 }] });
    expect((await availabilityOf(vB)).available).toBe(1);

    await admin`
      UPDATE stock_reservations SET expires_at = now() - interval '1 second'
      WHERE reference_id = ${reference.id}`;

    expect(await availabilityOf(vB)).toEqual({ onHand: 3, reserved: 0, available: 3 });
    // The row still exists — expiry needed no write to take effect.
    expect((await holdRows(reference.id)).length).toBe(1);
  });

  it("refuses all-or-nothing, naming exactly the failing lines", async () => {
    const vOk = await makeVariant(tenantA, true);
    const vShort = await makeVariant(tenantA, true);
    await seed(vOk, 5);
    await seed(vShort, 1);

    const reference = ref();
    const attempt = holdStock(ctx(), {
      reference,
      lines: [
        { variantId: vOk, quantity: 2 },
        { variantId: vShort, quantity: 2 },
      ],
    });
    await expect(attempt).rejects.toBeInstanceOf(InsufficientAvailabilityError);
    await expect(attempt).rejects.toMatchObject({
      code: "insufficient_stock",
      failedLines: [{ variantId: vShort, requested: 2, available: 1 }],
    });
    expect((await holdRows(reference.id)).length).toBe(0); // vOk was NOT held
  });

  it("replace semantics: a re-hold does not compete with itself and refreshes the window", async () => {
    const vC = await makeVariant(tenantA, true);
    await seed(vC, 3);
    const reference = ref();

    const first = await holdStock(ctx(), { reference, lines: [{ variantId: vC, quantity: 2 }] });
    // 3 on hand, 2 already held by THIS reference: a competing sum would
    // refuse 3; replace semantics must allow it.
    const second = await holdStock(ctx(), { reference, lines: [{ variantId: vC, quantity: 3 }] });

    expect(second.expiresAt.getTime()).toBeGreaterThanOrEqual(first.expiresAt.getTime());
    expect(await holdRows(reference.id)).toEqual([{ variant_id: vC, quantity: 3 }]);
    expect((await availabilityOf(vC)).available).toBe(0);
  });

  it("fails the whole hold on an unknown or cross-tenant variant", async () => {
    const vMine = await makeVariant(tenantA, true);
    const vTheirs = await makeVariant(tenantB, true);
    await seed(vMine, 5);

    const reference = ref();
    await expect(
      holdStock(ctx(), {
        reference,
        lines: [
          { variantId: vMine, quantity: 1 },
          { variantId: vTheirs, quantity: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(VariantNotFoundError);
    expect((await holdRows(reference.id)).length).toBe(0);
  });

  it("two concurrent holds for the last unit: exactly one wins", async () => {
    const vRace = await makeVariant(tenantA, true);
    await seed(vRace, 1);

    const results = await Promise.allSettled([
      holdStock(ctx(), { reference: ref(), lines: [{ variantId: vRace, quantity: 1 }] }),
      holdStock(ctx(), { reference: ref(), lines: [{ variantId: vRace, quantity: 1 }] }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      InsufficientAvailabilityError,
    );
    expect(await variantHoldCount(vRace)).toBe(1);
  });

  it("opportunistically sweeps the variant's expired rows while holding the lock", async () => {
    const vGc = await makeVariant(tenantA, true);
    await seed(vGc, 5);
    await insertHold(vGc, 1, -3600);
    await insertHold(vGc, 2, -7200);
    expect(await variantHoldCount(vGc)).toBe(2);

    await holdStock(ctx(), { reference: ref(), lines: [{ variantId: vGc, quantity: 1 }] });
    expect(await variantHoldCount(vGc)).toBe(1); // only the new live row remains
  });

  it("rejects empty lines, non-positive and duplicate quantities as invalid_payload", async () => {
    const vV = await makeVariant(tenantA, true);
    await seed(vV, 5);
    for (const lines of [
      [],
      [{ variantId: vV, quantity: 0 }],
      [{ variantId: vV, quantity: -1 }],
      [{ variantId: vV, quantity: 1.5 }],
      [
        { variantId: vV, quantity: 1 },
        { variantId: vV, quantity: 2 },
      ],
    ]) {
      await expect(holdStock(ctx(), { reference: ref(), lines })).rejects.toMatchObject({
        status: 422,
        code: "invalid_payload",
      });
    }
  });
});

describe("consumeStock", () => {
  it("consume held: sale movements carry the reference; rows gone; reconcile clean; ONE purge", async () => {
    const vSell = await makeVariant(tenantA, true);
    await seed(vSell, 4);
    const reference = ref();
    await holdStock(ctx(), { reference, lines: [{ variantId: vSell, quantity: 2 }] });
    received = [];

    const result = await consumeStock(ctx(), {
      reference,
      lines: [{ variantId: vSell, quantity: 2 }],
    });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.status).toBe("held");
    expect(result.lines[0]!.movementId).toBeTruthy();

    const raw = await withTenant(tenantA, (tx) => getStockLevels(tx, [vSell]));
    expect(raw.get(vSell)).toBe(2);
    expect((await holdRows(reference.id)).length).toBe(0);
    expect(await reconcileStockLevels(tenantA)).toEqual([]);

    const [movement] = await admin<
      { reason: string; reference_type: string; reference_id: string; note: string | null; created_by_user_id: string | null }[]
    >`
      SELECT reason, reference_type, reference_id, note, created_by_user_id
      FROM stock_movements WHERE variant_id = ${vSell} AND reason = 'sale'`;
    expect(movement).toMatchObject({
      reason: "sale",
      reference_type: "checkout",
      reference_id: reference.id,
      note: null,
      created_by_user_id: null,
    });

    const history = await getMovements(tenantA, vSell);
    expect(history[0]!.reason).toBe("sale");
    expect(history[0]!.createdByName).toBeNull();
    expect(history[0]!.referenceType).toBe("checkout");
    expect(history[0]!.referenceId).toBe(reference.id);

    expect(received.length).toBe(1);
    expect(received[0]!.tenantId).toBe(tenantA);
  });

  it("consume unheld-but-free: the hold lapsed, the stock was still there, the sale goes through", async () => {
    const vLapse = await makeVariant(tenantA, true);
    await seed(vLapse, 2);
    const reference = ref();
    await insertHold(vLapse, 1, -60, reference.id);

    const result = await consumeStock(ctx(), {
      reference,
      lines: [{ variantId: vLapse, quantity: 1 }],
    });
    expect(result.lines[0]!.status).toBe("unheld");
    expect((await withTenant(tenantA, (tx) => getStockLevels(tx, [vLapse]))).get(vLapse)).toBe(1);
  });

  it("consume stolen: whole rollback, ZERO sale movements, NO purge", async () => {
    const vStolen = await makeVariant(tenantA, true);
    await seed(vStolen, 1);
    const reference = ref();
    await insertHold(vStolen, 1, -60, reference.id); // expired hold
    await recordMovement(writeCtx(), { variantId: vStolen, delta: -1, note: "walk-in sale" });
    received = [];

    await expect(
      consumeStock(ctx(), { reference, lines: [{ variantId: vStolen, quantity: 1 }] }),
    ).rejects.toMatchObject({ code: "insufficient_stock", status: 422 });
    expect(await saleCount(vStolen)).toBe(0);
    expect(received.length).toBe(0);
  });

  it("consume respects OTHER references' active holds via stock_held", async () => {
    const vGuard = await makeVariant(tenantA, true);
    await seed(vGuard, 3);
    await insertHold(vGuard, 3, 900); // someone else holds all three
    const reference = ref(); // this reference holds nothing

    await expect(
      consumeStock(ctx(), { reference, lines: [{ variantId: vGuard, quantity: 1 }] }),
    ).rejects.toMatchObject({ code: "stock_held", status: 422 });
    expect(await saleCount(vGuard)).toBe(0);
    expect(await variantHoldCount(vGuard)).toBe(1); // the other hold survives
  });
});

describe("listInventory with holds", () => {
  it("carries reserved and available per row", async () => {
    const vList = await makeVariant(tenantA, true);
    await seed(vList, 4);
    await holdStock(ctx(), { reference: ref(), lines: [{ variantId: vList, quantity: 1 }] });

    const { items } = await listInventory(tenantA);
    const row = items.find((i) => i.variantId === vList)!;
    expect(row.onHand).toBe(4);
    expect(row.reserved).toBe(1);
    expect(row.available).toBe(3);
  });

  it("an expired hold contributes nothing", async () => {
    const vList2 = await makeVariant(tenantA, true);
    await seed(vList2, 2);
    await insertHold(vList2, 1, -60);

    const { items } = await listInventory(tenantA);
    const row = items.find((i) => i.variantId === vList2)!;
    expect(row.reserved).toBe(0);
    expect(row.available).toBe(2);
  });
});
