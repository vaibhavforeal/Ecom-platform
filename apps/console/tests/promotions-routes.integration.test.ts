import { createHash, randomUUID } from "node:crypto";

import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * /api/promotions CRUD against real PostgreSQL: authn/authz gates, zod
 * condition/effect refusals with the shared envelope, uppercased-code
 * persistence with audit, PUT replacement, and DELETE-archives. Route
 * handlers are called directly with constructed Requests; only
 * next/headers is stubbed.
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

const { GET: listRoute, POST: createRoute } = await import("../src/app/api/promotions/route");
const {
  GET: detailRoute,
  PUT: updateRoute,
  DELETE: archiveRoute,
} = await import("../src/app/api/promotions/[id]/route");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantId: string;
let ownerToken: string;
let processorToken: string;

const createdTenants = new Set<string>();
const createdUsers = new Set<string>();
const createdPlans = new Set<string>();

async function makeSession(tenant: string, role: string): Promise<string> {
  const userId = randomUUID();
  createdUsers.add(userId);
  const phone = "+9195" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userId}, ${phone}, 'Promo route test')`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, role, accepted_at)
    VALUES (${tenant}, ${userId}, ${role}, now())`;
  const token = randomUUID() + randomUUID();
  await admin`
    INSERT INTO sessions (id, token_hash, user_id, tenant_id, expires_at, idle_expires_at)
    VALUES (${randomUUID()}, ${createHash("sha256").update(token).digest("hex")},
            ${userId}, ${tenant}, now() + interval '1 day', now() + interval '1 day')`;
  return token;
}

type RouteResult = { status: number; data: Record<string, unknown> };

async function post(body: unknown): Promise<RouteResult> {
  const response = await createRoute(
    new Request("http://console.test/api/promotions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function list(query = ""): Promise<RouteResult> {
  const response = await listRoute(new Request(`http://console.test/api/promotions${query}`));
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function getOne(id: string): Promise<RouteResult> {
  const response = await detailRoute(new Request(`http://console.test/api/promotions/${id}`), {
    params: Promise.resolve({ id }),
  });
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function put(id: string, body: unknown): Promise<RouteResult> {
  const response = await updateRoute(
    new Request(`http://console.test/api/promotions/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function del(id: string): Promise<RouteResult> {
  const response = await archiveRoute(
    new Request(`http://console.test/api/promotions/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

let codeCounter = 0;
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  codeCounter += 1;
  return {
    code: `route-${String(codeCounter).padStart(3, "0")}-${randomUUID().slice(0, 6)}`,
    name: "Route test promotion",
    status: "active",
    conditions: [{ type: "cart_subtotal_min", paise: 50_000 }],
    effects: [{ type: "percent_off", bps: 1_000, maxDiscountPaise: 20_000 }],
    usageLimitTotal: 10,
    usageLimitPerCustomer: 1,
    ...overrides,
  };
}

async function promotionRow(id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await admin<Record<string, unknown>[]>`
    SELECT code, name, status, conditions, effects FROM promotions WHERE id = ${id}`;
  return row;
}

beforeAll(async () => {
  const slug = "promr-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"promr-" + randomUUID().slice(0, 8)}, 'Promo route plan')
    RETURNING id`;
  createdPlans.add(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  tenantId = tenant!.id;
  createdTenants.add(tenantId);

  ownerToken = await makeSession(tenantId, "owner");
  // order_processor holds NEITHER promotions:read NOR promotions:write.
  processorToken = await makeSession(tenantId, "order_processor");
});

afterEach(() => {
  sessionToken = undefined;
});

afterAll(async () => {
  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdUsers) await admin`DELETE FROM users WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  await closeConnections();
});

describe("promotions console routes", () => {
  it("refuses unauthenticated and under-permissioned callers, writing nothing", async () => {
    expect((await post(payload())).status).toBe(401);

    sessionToken = processorToken;
    expect((await post(payload())).status).toBe(403);
    expect((await list()).status).toBe(403);

    const rows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM promotions WHERE tenant_id = ${tenantId}`;
    expect(rows[0]!.n).toBe(0);
  });

  it("creates a promotion: 201, uppercased code, rules stored, audited, listed", async () => {
    sessionToken = ownerToken;
    const body = payload();
    const { status, data } = await post(body);
    expect(status).toBe(201);
    expect(data.code).toBe(String(body.code).toUpperCase());
    expect(data.id).toBeDefined();

    const row = await promotionRow(data.id as string);
    expect(row!.code).toBe(String(body.code).toUpperCase());
    expect(row!.effects).toEqual([{ type: "percent_off", bps: 1_000, maxDiscountPaise: 20_000 }]);

    const audits = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE tenant_id = ${tenantId} AND action = 'promotion.created' AND entity_id = ${data.id as string}`;
    expect(audits[0]!.n).toBe(1);

    const listed = await list("?status=active");
    expect(listed.status).toBe(200);
    const items = listed.data.items as { id: string }[];
    expect(items.some((p) => p.id === data.id)).toBe(true);

    const detail = await getOne(data.id as string);
    expect(detail.status).toBe(200);
    expect(detail.data.code).toBe(String(body.code).toUpperCase());
  });

  it("refuses bad conditions/effects with a field-level 422 envelope", async () => {
    sessionToken = ownerToken;

    const badCondition = await post(
      payload({ conditions: [{ type: "moon_phase", phase: "full" }] }),
    );
    expect(badCondition.status).toBe(422);
    expect((badCondition.data.error as { code: string }).code).toBe("invalid_payload");
    const conditionIssues = (
      badCondition.data.error as { details: { issues: { path: string }[] } }
    ).details.issues;
    expect(conditionIssues.some((i) => i.path.startsWith("conditions"))).toBe(true);

    const badEffect = await post(payload({ effects: [{ type: "percent_off", bps: 10_001 }] }));
    expect(badEffect.status).toBe(422);
    const effectIssues = (badEffect.data.error as { details: { issues: { path: string }[] } })
      .details.issues;
    expect(effectIssues.some((i) => i.path.startsWith("effects"))).toBe(true);

    const noEffects = await post(payload({ effects: [] }));
    expect(noEffects.status).toBe(422);
  });

  it("PUT replaces the whole promotion; malformed and unknown ids are 404s", async () => {
    sessionToken = ownerToken;
    const created = await post(payload());
    const id = created.data.id as string;

    const replaced = await put(
      id,
      payload({
        name: "Replaced",
        conditions: [],
        effects: [{ type: "free_shipping" }],
        usageLimitTotal: null,
      }),
    );
    expect(replaced.status).toBe(200);
    expect(replaced.data.name).toBe("Replaced");
    expect(replaced.data.effects).toEqual([{ type: "free_shipping" }]);
    expect(replaced.data.usageLimitTotal).toBeNull();

    expect((await put("not-a-uuid", payload())).status).toBe(404);
    expect((await put(randomUUID(), payload())).status).toBe(404);
    expect((await getOne("also-not-a-uuid")).status).toBe(404);
  });

  it("DELETE archives (never erases) and a duplicate code refuses 422", async () => {
    sessionToken = ownerToken;
    const body = payload();
    const created = await post(body);
    const id = created.data.id as string;

    const archived = await del(id);
    expect(archived.status).toBe(200);
    expect(archived.data.archived).toBe(true);

    const row = await promotionRow(id);
    expect(row).toBeDefined(); // still exists — archived, not erased
    expect(row!.status).toBe("archived");

    // Archiving is idempotent.
    expect((await del(id)).status).toBe(200);

    // The code stays taken by the archived row: tenant+code is unique.
    const duplicate = await post(payload({ code: body.code }));
    expect(duplicate.status).toBe(422);
    expect((duplicate.data.error as { code: string }).code).toBe("duplicate_code");
  });
});
