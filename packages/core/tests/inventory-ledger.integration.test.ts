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
let heldVariant: string;

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

async function insertHold(
  variantId: string,
  quantity: number,
  expiresOffsetSeconds: number,
): Promise<string> {
  const referenceId = randomUUID();
  const [loc] = await admin<{ id: string }[]>`
    SELECT id FROM locations WHERE tenant_id = ${tenantA} AND is_default`;
  await admin`
    INSERT INTO stock_reservations
      (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
    VALUES (${randomUUID()}, ${tenantA}, ${variantId}, ${loc!.id}, ${quantity},
            'checkout', ${referenceId}, now() + make_interval(secs => ${expiresOffsetSeconds}))`;
  return referenceId;
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
  heldVariant = await makeVariant(tenantA, true);
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

  it("rejects idempotency key reuse with different delta", async () => {
    const key = "idem-diff-delta-" + randomUUID();
    await recordMovement(ctx(tenantA), {
      variantId: trackedVariant,
      delta: 5,
      note: "first",
      idempotencyKey: key,
    });

    await expect(
      recordMovement(ctx(tenantA), {
        variantId: trackedVariant,
        delta: 10,
        note: "second attempt, different delta",
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({
      code: "idempotency_key_reuse",
      status: 422,
      publicMessage: "This idempotency key was already used for a different adjustment.",
    });
  });

  it("rejects idempotency key reuse with different variant", async () => {
    const key = "idem-diff-variant-" + randomUUID();
    const secondVariant = await makeVariant(tenantA, true);

    await recordMovement(ctx(tenantA), {
      variantId: trackedVariant,
      delta: 5,
      note: "first",
      idempotencyKey: key,
    });

    await expect(
      recordMovement(ctx(tenantA), {
        variantId: secondVariant,
        delta: 5,
        note: "second attempt, different variant",
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({
      code: "idempotency_key_reuse",
      status: 422,
      publicMessage: "This idempotency key was already used for a different adjustment.",
    });
  });

  it("replays exact-match idempotency key including note changes", async () => {
    const key = "idem-exact-" + randomUUID();
    const before = await movementCount(trackedVariant);

    const first = await recordMovement(ctx(tenantA), {
      variantId: trackedVariant,
      delta: 3,
      note: "original note",
      idempotencyKey: key,
    });

    // Same key, same variantId, same delta — note doesn't matter for fingerprint
    const second = await recordMovement(ctx(tenantA), {
      variantId: trackedVariant,
      delta: 3,
      note: "different note, but same fingerprint",
      idempotencyKey: key,
    });

    expect(second.replayed).toBe(true);
    expect(second.movementId).toBe(first.movementId);
    expect(second.delta).toBe(3);
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
    const successDelta = (fulfilled[0] as PromiseFulfilledResult<{ delta: number }>).value.delta;
    expect(levels.get(freshVariant)).toBe(successDelta);
  });
});

describe("recordMovement vs active holds", () => {
  it("a negative adjustment below active holds is refused with stock_held, atomically", async () => {
    await recordMovement(ctx(tenantA), { variantId: heldVariant, delta: 5, note: "opening" });
    await insertHold(heldVariant, 3, 900); // active for 15 minutes

    const before = await movementCount(heldVariant);
    await expect(
      recordMovement(ctx(tenantA), { variantId: heldVariant, delta: -3, note: "yank" }),
    ).rejects.toMatchObject({ code: "stock_held", status: 422 });
    expect(await movementCount(heldVariant)).toBe(before);
    expect(await reconcileStockLevels(tenantA)).toEqual([]);
  });

  it("an adjustment that leaves exactly the held quantity is allowed", async () => {
    // on-hand 5, held 3: dropping to 3 is legal (3 is not below 3).
    const result = await recordMovement(ctx(tenantA), {
      variantId: heldVariant,
      delta: -2,
      note: "boundary",
    });
    expect(result.onHand).toBe(3);
  });

  it("the refused adjustment succeeds once the hold has expired — with no other write", async () => {
    await admin`
      UPDATE stock_reservations SET expires_at = now() - interval '1 second'
      WHERE variant_id = ${heldVariant}`;
    const result = await recordMovement(ctx(tenantA), {
      variantId: heldVariant,
      delta: -3,
      note: "recount",
    });
    expect(result.onHand).toBe(0);
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
