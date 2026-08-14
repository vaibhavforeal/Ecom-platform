import { createHash, randomUUID } from "node:crypto";

import { closeRedis, invalidateHostCache, platformKey, redis, resolveTenantByHost } from "@platform/core";
import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * PUT /api/settings against real PostgreSQL and Redis.
 *
 * The route handler is called directly with a constructed `Request`,
 * exactly as product-crud.integration.test.ts does. Only `next/headers`
 * is stubbed; the session, membership and permission checks run for
 * real.
 *
 * `tenants` has no RLS, so every DB assertion here is about the table
 * itself — reads go through the migrator connection like the other
 * suites, for consistency rather than necessity.
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

const { PUT: updateSettingsRoute } = await import("../src/app/api/settings/route");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

/** Tenant A: happy path, validation, authz. B: cache invalidation. C: no-op. */
let tenantA: string;
let tenantB: string;
let tenantC: string;
let hostB: string;
let hostC: string;
let ownerAToken: string;
let _ownerAUserId: string;
let catalogManagerAToken: string;
let ownerBToken: string;
let ownerCToken: string;

const createdTenants = new Set<string>();
const createdUsers = new Set<string>();
const createdPlans = new Set<string>();

async function makeTenant(): Promise<{ id: string; hostname: string }> {
  const slug = "st-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"st-" + randomUUID().slice(0, 8)}, 'Settings test plan')
    RETURNING id`;
  createdPlans.add(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  createdTenants.add(tenant!.id);
  // A verified domain so resolveTenantByHost can warm the Redis host
  // cache for this tenant. Cascade-deleted with the tenant.
  const hostname = `${slug}.settings-test.localhost`;
  await admin`
    INSERT INTO domains (id, tenant_id, hostname, is_primary, verified_at)
    VALUES (${randomUUID()}, ${tenant!.id}, ${hostname}, true, now())`;
  return { id: tenant!.id, hostname };
}

async function makeSession(
  tenantId: string,
  role: string,
): Promise<{ token: string; userId: string }> {
  const userId = randomUUID();
  createdUsers.add(userId);
  const phone = "+9197" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userId}, ${phone}, 'Settings test')`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, role, accepted_at)
    VALUES (${tenantId}, ${userId}, ${role}, now())`;

  const token = randomUUID() + randomUUID();
  await admin`
    INSERT INTO sessions (id, token_hash, user_id, tenant_id, expires_at, idle_expires_at)
    VALUES (${randomUUID()}, ${createHash("sha256").update(token).digest("hex")},
            ${userId}, ${tenantId}, now() + interval '1 day', now() + interval '1 day')`;

  return { token, userId };
}

async function putSettings(
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await updateSettingsRoute(
    new Request("http://console.test/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

type TenantRow = { search_indexing: string; updated_at: Date };

async function tenantRow(id: string): Promise<TenantRow> {
  const [row] = await admin<TenantRow[]>`
    SELECT search_indexing, updated_at FROM tenants WHERE id = ${id}`;
  return row!;
}

async function settingsAudits(
  tenantId: string,
): Promise<{ action: string; before: unknown; after: unknown }[]> {
  return admin<{ action: string; before: unknown; after: unknown }[]>`
    SELECT action, before, after FROM audit_log
    WHERE tenant_id = ${tenantId} AND action = 'settings.search_indexing_changed'
    ORDER BY created_at`;
}

beforeAll(async () => {
  const a = await makeTenant();
  const b = await makeTenant();
  const c = await makeTenant();
  tenantA = a.id;
  tenantB = b.id;
  hostB = b.hostname;
  tenantC = c.id;
  hostC = c.hostname;

  const ownerA = await makeSession(tenantA, "owner");
  ownerAToken = ownerA.token;
  _ownerAUserId = ownerA.userId;
  catalogManagerAToken = (await makeSession(tenantA, "catalog_manager")).token;
  ownerBToken = (await makeSession(tenantB, "owner")).token;
  ownerCToken = (await makeSession(tenantC, "owner")).token;
});

afterEach(() => {
  sessionToken = undefined;
});

afterAll(async () => {
  // The warmed host keys have a 300 s TTL, but leave nothing behind.
  await invalidateHostCache([hostB, hostC]);
  await closeRedis();
  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdUsers) await admin`DELETE FROM users WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  await closeConnections();
});

describe("PUT /api/settings", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const { status } = await putSettings({ searchIndexing: "noindex" });
    expect(status).toBe(401);
  });

  it("refuses a role holding only settings:read with 403", async () => {
    sessionToken = catalogManagerAToken;
    const { status, data } = await putSettings({ searchIndexing: "noindex" });
    expect(status).toBe(403);
    expect((data.error as { code: string }).code).toBe("forbidden");
    // And nothing changed.
    expect((await tenantRow(tenantA)).search_indexing).toBe("auto");
  });

  it("refuses a value outside the enum with a field-level 422", async () => {
    sessionToken = ownerAToken;
    const { status, data } = await putSettings({ searchIndexing: "always" });
    expect(status).toBe(422);
    const error = data.error as { code: string; details: { issues: { path: string }[] } };
    expect(error.code).toBe("invalid_payload");
    expect(error.details.issues.some((i) => i.path === "searchIndexing")).toBe(true);
  });

  it("updates the column, bumps updated_at, and writes the audit row", async () => {
    sessionToken = ownerAToken;
    const before = await tenantRow(tenantA);
    expect(before.search_indexing).toBe("auto");

    const { status, data } = await putSettings({ searchIndexing: "noindex" });
    expect(status).toBe(200);
    expect(data.searchIndexing).toBe("noindex");
    expect(data.changed).toBe(true);

    const after = await tenantRow(tenantA);
    expect(after.search_indexing).toBe("noindex");
    expect(after.updated_at.getTime()).not.toBe(before.updated_at.getTime());

    const audits = await settingsAudits(tenantA);
    expect(audits.length).toBe(1);
    expect(audits[0]!.before).toEqual({ searchIndexing: "auto" });
    expect(audits[0]!.after).toEqual({ searchIndexing: "noindex" });
  });

  it("invalidates the Redis host cache so the resolver serves the new value", async () => {
    // Warm the cache from the DB, as a storefront request would.
    const warmed = await resolveTenantByHost(hostB);
    expect(warmed?.searchIndexing).toBe("auto");

    sessionToken = ownerBToken;
    const { status } = await putSettings({ searchIndexing: "indexed" });
    expect(status).toBe(200);

    // Without invalidation this still serves the 300 s-cached "auto".
    const fresh = await resolveTenantByHost(hostB);
    expect(fresh?.searchIndexing).toBe("indexed");
  });

  it("treats writing the current value as a no-op: no audit row, cache untouched", async () => {
    const warmed = await resolveTenantByHost(hostC);
    expect(warmed?.searchIndexing).toBe("auto");

    sessionToken = ownerCToken;
    const { status, data } = await putSettings({ searchIndexing: "auto" });
    expect(status).toBe(200);
    expect(data.changed).toBe(false);

    expect(await settingsAudits(tenantC)).toEqual([]);
    // The warmed key is still there — a no-op must not purge.
    expect(await redis().get(platformKey("host", hostC))).not.toBeNull();
  });
});
