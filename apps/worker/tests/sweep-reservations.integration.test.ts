import { randomUUID } from "node:crypto";

import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sweepReservations } from "../src/jobs/sweep-reservations";

/**
 * The GC sweep against real Postgres. The load-bearing assertion is the
 * per-tenant iteration: a cross-tenant DELETE on the app role would
 * silently match ZERO rows under RLS — the sweep must visit tenants.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

const createdTenants: string[] = [];
const createdPlans: string[] = [];

type Fixture = { tenantId: string; old: string; recent: string; active: string };
let a: Fixture;
let b: Fixture;

async function mkTenantWithHolds(): Promise<Fixture> {
  const slug = "gc-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"gc-" + randomUUID().slice(0, 8)}, 'GC test plan')
    RETURNING id`;
  createdPlans.push(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  createdTenants.push(tenant!.id);

  const [product] = await admin<{ id: string }[]>`
    INSERT INTO products (id, tenant_id, title, status)
    VALUES (${randomUUID()}, ${tenant!.id}, 'GC product', 'active')
    RETURNING id`;
  const [variant] = await admin<{ id: string }[]>`
    INSERT INTO product_variants
      (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory)
    VALUES (${randomUUID()}, ${tenant!.id}, ${product!.id},
            ${"GC-" + randomUUID().slice(0, 8)}, 9900, 100, true)
    RETURNING id`;
  const [loc] = await admin<{ id: string }[]>`
    INSERT INTO locations (id, tenant_id, name, is_default)
    VALUES (${randomUUID()}, ${tenant!.id}, 'Default', true)
    RETURNING id`;

  const mkHold = async (interval: string): Promise<string> => {
    const [row] = await admin<{ id: string }[]>`
      INSERT INTO stock_reservations
        (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
      VALUES (${randomUUID()}, ${tenant!.id}, ${variant!.id}, ${loc!.id}, 1,
              'checkout', ${randomUUID()}, now() + ${interval}::interval)
      RETURNING id`;
    return row!.id;
  };

  return {
    tenantId: tenant!.id,
    old: await mkHold("-2 days"),      // expired long ago → swept
    recent: await mkHold("-1 minute"), // expired, within the grace day → kept
    active: await mkHold("15 minutes"), // live → kept
  };
}

async function exists(id: string): Promise<boolean> {
  const [row] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_reservations WHERE id = ${id}`;
  return row!.n === 1;
}

beforeAll(async () => {
  a = await mkTenantWithHolds();
  b = await mkTenantWithHolds();
});

afterAll(async () => {
  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  await closeConnections();
});

describe("sweepReservations", () => {
  it("deletes only rows expired beyond the grace day, in EVERY tenant", async () => {
    const result = await sweepReservations();

    // Other suites' tenants may exist concurrently; assert our rows and
    // a lower bound, never exact totals.
    expect(result.deleted).toBeGreaterThanOrEqual(2);
    expect(result.tenantsSwept).toBeGreaterThanOrEqual(2);

    for (const f of [a, b]) {
      expect(await exists(f.old)).toBe(false);
      expect(await exists(f.recent)).toBe(true);
      expect(await exists(f.active)).toBe(true);
    }
  });
});
