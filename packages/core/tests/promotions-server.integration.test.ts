import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeConnections, withTenant } from "@platform/db";
import type { AppError } from "@platform/core";
import {
  archivePromotion,
  claimRedemption,
  countPendingClaims,
  countRedemptions,
  createPromotion,
  getPromotion,
  listPromotions,
  loadActivePromotionForUpdate,
  updatePromotion,
} from "@platform/core/promotions/server";
import type { PromotionData } from "@platform/core/promotions";

/**
 * The promotions write door and the redemption slot mechanics against
 * real Postgres: CRUD with audit, zod refusal at the domain door, code
 * uniqueness per tenant, per-customer slots, exhaustion, the D8 lock
 * serializing concurrent claims at the last slot, and the read-side
 * expiry filter on pending-claim counting.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantA: string;
let tenantB: string;
let userA: string;

const createdTenants = new Set<string>();
const createdUsers = new Set<string>();
const createdPlans = new Set<string>();

function writeCtx(tenantId = tenantA) {
  return { tenantId, actorUserId: userA, ip: null, userAgent: null, requestId: "promo-test" };
}

async function makeTenant(): Promise<string> {
  const slug = "promo-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"promo-" + randomUUID().slice(0, 8)}, 'Promotions test plan')
    RETURNING id`;
  createdPlans.add(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  createdTenants.add(tenant!.id);
  return tenant!.id;
}

let codeCounter = 0;
function nextCode(): string {
  codeCounter += 1;
  return `PROMO-${String(codeCounter).padStart(3, "0")}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

function basePromotion(code = nextCode()) {
  return {
    code,
    name: "Test promotion",
    status: "active" as const,
    conditions: [],
    effects: [{ type: "flat_off" as const, paise: 10_000 }],
  };
}

async function makePromotion(
  overrides: Partial<Parameters<typeof createPromotion>[1]> = {},
): Promise<PromotionData> {
  return createPromotion(writeCtx(), { ...basePromotion(), ...overrides });
}

/** A pending_payment order carrying the promotion, expiring at the offset. */
let orderNumber = 5000;
async function insertPendingOrder(
  promotionId: string,
  expiresOffsetSeconds: number,
  status = "pending_payment",
): Promise<string> {
  const id = randomUUID();
  orderNumber += 1;
  await admin`
    INSERT INTO orders
      (id, tenant_id, order_number, status, buyer_name, buyer_phone_e164,
       shipping_address, place_of_supply, payment_mode,
       subtotal_paise, total_paise, promotion_id, expires_at)
    VALUES
      (${id}, ${tenantA}, ${orderNumber}, ${status},
       'Promo Buyer', '+919700000000',
       ${JSON.stringify({ line1: "1 Test St", city: "Pune", state_code: "27", pincode: "411001" })}::text::jsonb,
       '27', 'prepaid', 100000, 100000, ${promotionId},
       now() + make_interval(secs => ${expiresOffsetSeconds}))`;
  return id;
}

async function claim(
  promotion: PromotionData,
  orderId: string,
  customerId: string | null,
): Promise<Awaited<ReturnType<typeof claimRedemption>>> {
  return withTenant(tenantA, (tx) =>
    claimRedemption(tx, tenantA, { promotion, orderId, customerId, discountPaise: 10_000 }),
  );
}

beforeAll(async () => {
  tenantA = await makeTenant();
  tenantB = await makeTenant();
  userA = randomUUID();
  createdUsers.add(userA);
  const phone = "+9198" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userA}, ${phone}, 'Promo tester')`;
});

afterAll(async () => {
  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdUsers) await admin`DELETE FROM users WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  await closeConnections();
});

describe("promotions write door", () => {
  it("creates with an uppercased code, stores parsed rules, audits, and reads back", async () => {
    const code = nextCode();
    const created = await createPromotion(writeCtx(), {
      code: code.toLowerCase(),
      name: "Ten percent off",
      status: "active",
      startsAt: new Date("2026-01-01T00:00:00Z"),
      endsAt: new Date("2027-01-01T00:00:00Z"),
      conditions: [{ type: "cart_subtotal_min", paise: 99_900 }],
      effects: [{ type: "percent_off", bps: 1_000, maxDiscountPaise: 50_000 }],
      usageLimitTotal: 100,
      usageLimitPerCustomer: 1,
    });

    expect(created.code).toBe(code.toUpperCase());
    expect(created.effects).toEqual([
      { type: "percent_off", bps: 1_000, maxDiscountPaise: 50_000 },
    ]);

    const read = await getPromotion(tenantA, created.id);
    expect(read).not.toBeNull();
    expect(read!.conditions).toEqual([{ type: "cart_subtotal_min", paise: 99_900 }]);
    expect(read!.usageLimitTotal).toBe(100);
    expect(read!.startsAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    const audits = await admin<{ action: string }[]>`
      SELECT action FROM audit_log
      WHERE tenant_id = ${tenantA} AND entity_type = 'promotion' AND entity_id = ${created.id}`;
    expect(audits.map((a) => a.action)).toContain("promotion.created");
  });

  it("refuses invalid rules at the domain door with field-level issues, writing nothing", async () => {
    const before = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM promotions WHERE tenant_id = ${tenantA}`;

    const bad = createPromotion(writeCtx(), {
      ...basePromotion(),
      conditions: [{ type: "moon_phase", phase: "full" } as never],
      effects: [{ type: "percent_off", bps: 10_001 } as never],
    });
    await expect(bad).rejects.toMatchObject({
      code: "invalid_payload",
      status: 422,
    });
    await bad.catch((err: AppError) => {
      const issues = (err.details as { issues: { path: string }[] }).issues;
      expect(issues.some((i) => i.path === "conditions.0")).toBe(true);
      expect(issues.some((i) => i.path === "effects.0")).toBe(true);
    });

    const after = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM promotions WHERE tenant_id = ${tenantA}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("refuses a duplicate code within the tenant, allows it in another tenant", async () => {
    const code = nextCode();
    await makePromotion({ code });
    await expect(makePromotion({ code })).rejects.toMatchObject({
      code: "duplicate_code",
      status: 422,
    });

    // Same code, different tenant: the unique index is (tenant_id, code).
    const other = await createPromotion(
      { ...writeCtx(tenantB) },
      { ...basePromotion(code) },
    );
    expect(other.code).toBe(code);
  });

  it("updates rules with before/after audit, archives via the DELETE door idempotently, filters lists", async () => {
    const created = await makePromotion({ status: "draft" });

    const updated = await updatePromotion(writeCtx(), created.id, {
      ...basePromotion(created.code),
      name: "Renamed",
      status: "active",
      effects: [{ type: "free_shipping" }],
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.status).toBe("active");
    expect(updated.effects).toEqual([{ type: "free_shipping" }]);

    const activeList = await listPromotions(tenantA, { status: "active" });
    expect(activeList.items.some((p) => p.id === created.id)).toBe(true);

    await archivePromotion(writeCtx(), created.id);
    await archivePromotion(writeCtx(), created.id); // idempotent second archive
    const archived = await getPromotion(tenantA, created.id);
    expect(archived!.status).toBe("archived");

    const archivedList = await listPromotions(tenantA, { status: "archived" });
    expect(archivedList.items.some((p) => p.id === created.id)).toBe(true);
    const activeAfter = await listPromotions(tenantA, { status: "active" });
    expect(activeAfter.items.some((p) => p.id === created.id)).toBe(false);

    const audits = await admin<{ action: string; before: unknown; after: unknown }[]>`
      SELECT action, before, after FROM audit_log
      WHERE tenant_id = ${tenantA} AND entity_type = 'promotion' AND entity_id = ${created.id}
      ORDER BY created_at`;
    const update = audits.find((a) => a.action === "promotion.updated");
    expect(update).toBeDefined();
    expect((update!.before as { name: string }).name).toBe("Test promotion");
    expect((update!.after as { name: string }).name).toBe("Renamed");
    expect(audits.some((a) => a.action === "promotion.archived")).toBe(true);

    // updatePromotion on a missing id is a typed 404.
    await expect(
      updatePromotion(writeCtx(), randomUUID(), basePromotion()),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("loadActivePromotionForUpdate finds active rows by any-cased code, never draft/archived", async () => {
    const active = await makePromotion({ status: "active" });
    const draft = await makePromotion({ status: "draft" });

    await withTenant(tenantA, async (tx) => {
      const found = await loadActivePromotionForUpdate(tx, tenantA, active.code.toLowerCase());
      expect(found).not.toBeNull();
      expect(found!.id).toBe(active.id);

      expect(await loadActivePromotionForUpdate(tx, tenantA, draft.code)).toBeNull();
      expect(await loadActivePromotionForUpdate(tx, tenantA, "NO-SUCH-CODE")).toBeNull();
    });
  });
});

describe("claimRedemption slot mechanics", () => {
  it("claims sequential slots, tracks per-customer slots, replays the same order", async () => {
    const promotion = await makePromotion({ usageLimitTotal: 10, usageLimitPerCustomer: 2 });
    const customer1 = randomUUID();
    const customer2 = randomUUID();

    const first = await claim(promotion, randomUUID(), customer1);
    expect(first).toMatchObject({ claimed: true, slot: 0, customerSlot: 0 });

    const second = await claim(promotion, randomUUID(), customer1);
    expect(second).toMatchObject({ claimed: true, slot: 1, customerSlot: 1 });

    const third = await claim(promotion, randomUUID(), customer2);
    expect(third).toMatchObject({ claimed: true, slot: 2, customerSlot: 0 });

    // The same order replays its original claim — no new slot burned.
    const orderId = randomUUID();
    const fresh = await claim(promotion, orderId, customer2);
    const replayed = await claim(promotion, orderId, customer2);
    expect(fresh.claimed && replayed.claimed).toBe(true);
    expect(replayed).toEqual(fresh);

    await withTenant(tenantA, async (tx) => {
      expect(await countRedemptions(tx, tenantA, promotion.id)).toBe(4);
    });
  });

  it("refuses the per-customer limit with {claimed:false} while total slots remain", async () => {
    const promotion = await makePromotion({ usageLimitTotal: 10, usageLimitPerCustomer: 1 });
    const customer = randomUUID();

    expect((await claim(promotion, randomUUID(), customer)).claimed).toBe(true);
    expect(await claim(promotion, randomUUID(), customer)).toEqual({
      claimed: false,
      reason: "coupon_exhausted",
    });
    // A different customer still fits.
    expect((await claim(promotion, randomUUID(), randomUUID())).claimed).toBe(true);
  });

  it("refuses at the total limit and never inserts past it — the unique index is the enforcer", async () => {
    const promotion = await makePromotion({ usageLimitTotal: 2 });

    expect((await claim(promotion, randomUUID(), null)).claimed).toBe(true);
    expect((await claim(promotion, randomUUID(), null)).claimed).toBe(true);
    expect(await claim(promotion, randomUUID(), null)).toEqual({
      claimed: false,
      reason: "coupon_exhausted",
    });

    const rows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM coupon_redemptions
      WHERE tenant_id = ${tenantA} AND promotion_id = ${promotion.id}`;
    expect(rows[0]!.n).toBe(2);
  });

  it("serializes concurrent claims on the promotion row lock (D8): one wins the last slot", async () => {
    const promotion = await makePromotion({ usageLimitTotal: 1 });

    const [a, b] = await Promise.all([
      claim(promotion, randomUUID(), null),
      claim(promotion, randomUUID(), null),
    ]);

    // The FOR UPDATE inside claimRedemption serializes the two counts:
    // exactly one claims slot 0, the other sees the limit — no 23505,
    // no double redemption.
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    const rows = await admin<{ slot: number }[]>`
      SELECT slot FROM coupon_redemptions
      WHERE tenant_id = ${tenantA} AND promotion_id = ${promotion.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slot).toBe(0);
  });
});

describe("countPendingClaims (checkout-start advisory, D8)", () => {
  it("counts only unexpired pending_payment orders — the read-side expiry filter", async () => {
    const promotion = await makePromotion({ usageLimitTotal: 5 });

    await insertPendingOrder(promotion.id, 900); // live pending claim
    await insertPendingOrder(promotion.id, -60); // expired: filtered read-side
    await insertPendingOrder(promotion.id, 900, "cancelled"); // wrong status
    await insertPendingOrder(randomUUID(), 900); // different promotion

    await withTenant(tenantA, async (tx) => {
      expect(await countPendingClaims(tx, tenantA, promotion.id)).toBe(1);
    });
  });
});
