import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeConnections, withTenant } from "@platform/db";
import {
  InsufficientStockError,
  UntrackedVariantError,
  VariantNotFoundError,
  getMovements,
  getStockLevels,
  listInventory,
  recordMovement,
  reconcileStockLevels,
} from "@platform/core/inventory/server";

/**
 * The ledger's invariants, proven against real Postgres:
 * atomicity (a refused movement leaves NO ledger row), the CHECK-backed
 * oversell guard under real concurrency, idempotent replay, and the
 * projection's agreement with SUM(delta).
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantA: string;
let tenantB: string;
let userA: string;
let trackedVariant: string;
let untrackedVariant: string;
let otherTenantVariant: string;
let raceVariant: string;

const createdTenants = new Set<string>();
const createdUsers = new Set<string>();
const createdPlans = new Set<string>();

function ctx(tenantId: string) {
  return { tenantId, actorUserId: userA, ip: null, userAgent: null, requestId: "inv-test" };
}

async function makeTenant(): Promise<string> {
  const slug = "inv-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"inv-" + randomUUID().slice(0, 8)}, 'Inventory test plan')
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
    VALUES (${randomUUID()}, ${tenantId}, ${"inv-product-" + randomUUID().slice(0, 8)}, 'active')
    RETURNING id`;
  const [variant] = await admin<{ id: string }[]>`
    INSERT INTO product_variants
      (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory)
    VALUES
      (${randomUUID()}, ${tenantId}, ${product!.id}, ${"INV-" + randomUUID().slice(0, 8)},
       19900, 500, ${tracked})
    RETURNING id`;
  return variant!.id;
}

async function movementCount(variantId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = ${variantId}`;
  return row!.n;
}

beforeAll(async () => {
  tenantA = await makeTenant();
  tenantB = await makeTenant();
  userA = randomUUID();
  createdUsers.add(userA);
  const phone = "+9198" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userA}, ${phone}, 'Inv tester')`;

  trackedVariant = await makeVariant(tenantA, true);
  untrackedVariant = await makeVariant(tenantA, false);
  raceVariant = await makeVariant(tenantA, true);
  otherTenantVariant = await makeVariant(tenantB, true);
});

afterAll(async () => {
  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdUsers) await admin`DELETE FROM users WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  await closeConnections();
});

describe("recordMovement", () => {
  it("first movement is opening_balance; the projection and reads agree", async () => {
    const result = await recordMovement(ctx(tenantA), {
      variantId: trackedVariant,
      delta: 5,
      note: "opening count",
    });
    expect(result.reason).toBe("opening_balance");
    expect(result.onHand).toBe(5);
    expect(result.replayed).toBe(false);

    const levels = await withTenant(tenantA, (tx) => getStockLevels(tx, [trackedVariant]));
    expect(levels.get(trackedVariant)).toBe(5);
  });

  it("second movement is adjustment; sums correctly; reconcile is clean", async () => {
    const result = await recordMovement(ctx(tenantA), {
      variantId: trackedVariant,
      delta: -2,
      note: "damaged in transit",
    });
    expect(result.reason).toBe("adjustment");
    expect(result.onHand).toBe(3);

    expect(await reconcileStockLevels(tenantA)).toEqual([]);

    const history = await getMovements(tenantA, trackedVariant);
    expect(history.map((m) => m.delta)).toEqual([-2, 5]); // newest first
    expect(history[0]!.note).toBe("damaged in transit");
    expect(history[0]!.createdByName).toBe("Inv tester");
  });

  it("a movement below zero is refused atomically: 422 and NO ledger row", async () => {
    const before = await movementCount(trackedVariant);
    await expect(
      recordMovement(ctx(tenantA), { variantId: trackedVariant, delta: -99, note: "oops" }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await movementCount(trackedVariant)).toBe(before);
    expect(await reconcileStockLevels(tenantA)).toEqual([]);
  });

  it("refuses an untracked variant", async () => {
    await expect(
      recordMovement(ctx(tenantA), { variantId: untrackedVariant, delta: 1, note: "x" }),
    ).rejects.toBeInstanceOf(UntrackedVariantError);
  });

  it("another tenant's variant id is not found, not adjusted", async () => {
    await expect(
      recordMovement(ctx(tenantA), { variantId: otherTenantVariant, delta: 1, note: "x" }),
    ).rejects.toBeInstanceOf(VariantNotFoundError);
  });

  it("refuses delta 0 and deltas beyond the cap", async () => {
    for (const delta of [0, 1_000_001, -1_000_001]) {
      await expect(
        recordMovement(ctx(tenantA), { variantId: trackedVariant, delta, note: "x" }),
      ).rejects.toMatchObject({ status: 422 });
    }
  });

  it("replays an idempotency key instead of double-writing", async () => {
    const key = "idem-" + randomUUID();
    const before = await movementCount(trackedVariant);

    const first = await recordMovement(ctx(tenantA), {
      variantId: trackedVariant,
      delta: 1,
      note: "restock",
      idempotencyKey: key,
    });
    const second = await recordMovement(ctx(tenantA), {
      variantId: trackedVariant,
      delta: 1,
      note: "restock",
      idempotencyKey: key,
    });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.movementId).toBe(first.movementId);
    expect(second.onHand).toBe(first.onHand);
    expect(await movementCount(trackedVariant)).toBe(before + 1);
  });

  it("two concurrent decrements of the last unit: exactly one succeeds", async () => {
    await recordMovement(ctx(tenantA), { variantId: raceVariant, delta: 1, note: "one unit" });

    const results = await Promise.allSettled([
      recordMovement(ctx(tenantA), { variantId: raceVariant, delta: -1, note: "race A" }),
      recordMovement(ctx(tenantA), { variantId: raceVariant, delta: -1, note: "race B" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientStockError);

    const levels = await withTenant(tenantA, (tx) => getStockLevels(tx, [raceVariant]));
    expect(levels.get(raceVariant)).toBe(0);
    expect(await reconcileStockLevels(tenantA)).toEqual([]);
  });

  it("creates exactly one default location however many movements land", async () => {
    const [row] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM locations WHERE tenant_id = ${tenantA}`;
    expect(row!.n).toBe(1);
  });

  it("two concurrent first movements: exactly one succeeds, one gets 409", async () => {
    const freshVariant = await makeVariant(tenantA, true);

    const results = await Promise.allSettled([
      recordMovement(ctx(tenantA), { variantId: freshVariant, delta: 10, note: "race 1" }),
      recordMovement(ctx(tenantA), { variantId: freshVariant, delta: 20, note: "race 2" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const rejection = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejection).toHaveProperty("status", 409);
    expect(rejection).toHaveProperty("code", "concurrent_modification");

    // Ledger consistency: exactly one movement recorded
    const count = await movementCount(freshVariant);
    expect(count).toBe(1);

    // Projection clean: reconcile shows no drift
    expect(await reconcileStockLevels(tenantA)).toEqual([]);

    // On-hand matches the successful movement
    const levels = await withTenant(tenantA, (tx) => getStockLevels(tx, [freshVariant]));
    const successDelta = (fulfilled[0] as PromiseFulfilledResult<any>).value.delta;
    expect(levels.get(freshVariant)).toBe(successDelta);
  });
});

describe("listInventory", () => {
  it("lists tracked variants with levels; lowStockOnly filters", async () => {
    const all = await listInventory(tenantA);
    const ids = all.items.map((i) => i.variantId);
    expect(ids).toContain(trackedVariant);
    expect(ids).toContain(raceVariant);
    expect(ids).not.toContain(untrackedVariant);
    expect(ids).not.toContain(otherTenantVariant);

    // raceVariant sits at 0 with the default lowStockAt of 2 → low.
    const low = await listInventory(tenantA, { lowStockOnly: true });
    expect(low.items.map((i) => i.variantId)).toContain(raceVariant);
  });
});
