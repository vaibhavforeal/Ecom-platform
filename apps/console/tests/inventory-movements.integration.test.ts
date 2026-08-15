import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * POST /api/inventory/movements against real PostgreSQL, with a stub
 * storefront capturing purges. The route handler is called directly with
 * a constructed Request; only next/headers is stubbed.
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

const { POST: postMovementRoute } = await import("../src/app/api/inventory/movements/route");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

const TEST_SECRET = "inventory-purge-secret-9f21ce";
let purgeServer: Server;
let received: { tags: string[]; tenantId: string }[] = [];
let savedOrigin: string | undefined;
let savedSecret: string | undefined;

let tenantId: string;
let ownerToken: string;
let processorToken: string;
let productId: string;
let trackedVariant: string;
let untrackedVariant: string;

const createdTenants = new Set<string>();
const createdUsers = new Set<string>();
const createdPlans = new Set<string>();

async function makeSession(tenant: string, role: string): Promise<string> {
  const userId = randomUUID();
  createdUsers.add(userId);
  const phone = "+9196" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userId}, ${phone}, 'Inv route test')`;
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

async function postMovement(
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await postMovementRoute(
    new Request("http://console.test/api/inventory/movements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function ledgerCount(variantId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = ${variantId}`;
  return row!.n;
}

beforeAll(async () => {
  const slug = "invr-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"invr-" + randomUUID().slice(0, 8)}, 'Inv route plan')
    RETURNING id`;
  createdPlans.add(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  tenantId = tenant!.id;
  createdTenants.add(tenantId);

  ownerToken = await makeSession(tenantId, "owner");
  processorToken = await makeSession(tenantId, "order_processor"); // inventory:read, NOT write

  const [product] = await admin<{ id: string }[]>`
    INSERT INTO products (id, tenant_id, title, status)
    VALUES (${randomUUID()}, ${tenantId}, 'Inv route product', 'active')
    RETURNING id`;
  productId = product!.id;
  // Distinct options per variant: product_variants_option_combo_key is
  // unique on (tenant, product, options), and two `{}` rows collide.
  const mkVariant = async (tracked: boolean, size: string) => {
    const [v] = await admin<{ id: string }[]>`
      INSERT INTO product_variants
        (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory, options)
      VALUES (${randomUUID()}, ${tenantId}, ${productId},
              ${"INVR-" + randomUUID().slice(0, 8)}, 9900, 250, ${tracked},
              ${JSON.stringify({ Size: size })}::text::jsonb)
      RETURNING id`;
    return v!.id;
  };
  trackedVariant = await mkVariant(true, "M");
  untrackedVariant = await mkVariant(false, "L");

  // Stub storefront: capture every purge POST.
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
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
});

afterEach(() => {
  sessionToken = undefined;
  received = [];
});

afterAll(async () => {
  // Restore env BEFORE the pool closes (the worker-suite lesson).
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

describe("POST /api/inventory/movements", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const { status } = await postMovement({ variantId: trackedVariant, delta: 1, note: "x" });
    expect(status).toBe(401);
  });

  it("refuses a role holding only inventory:read with 403, writing nothing", async () => {
    sessionToken = processorToken;
    const before = await ledgerCount(trackedVariant);
    const { status } = await postMovement({ variantId: trackedVariant, delta: 1, note: "x" });
    expect(status).toBe(403);
    expect(await ledgerCount(trackedVariant)).toBe(before);
  });

  it("refuses delta 0 and a missing note with field-level 422s", async () => {
    sessionToken = ownerToken;
    const zero = await postMovement({ variantId: trackedVariant, delta: 0, note: "x" });
    expect(zero.status).toBe(422);
    const zeroIssues = (zero.data.error as { details: { issues: { path: string }[] } }).details.issues;
    expect(zeroIssues.some((i) => i.path === "delta")).toBe(true);

    const noNote = await postMovement({ variantId: trackedVariant, delta: 1 });
    expect(noNote.status).toBe(422);
    const noteIssues = (noNote.data.error as { details: { issues: { path: string }[] } }).details.issues;
    expect(noteIssues.some((i) => i.path === "note")).toBe(true);
  });

  it("404s an unknown variant id", async () => {
    sessionToken = ownerToken;
    const { status } = await postMovement({ variantId: randomUUID(), delta: 1, note: "x" });
    expect(status).toBe(404);
  });

  it("refuses an untracked variant with 422", async () => {
    sessionToken = ownerToken;
    const { status, data } = await postMovement({ variantId: untrackedVariant, delta: 1, note: "x" });
    expect(status).toBe(422);
    expect((data.error as { code: string }).code).toBe("untracked_variant");
  });

  it("records a movement: ledger row, projection, audit, purge after commit", async () => {
    sessionToken = ownerToken;
    const { status, data } = await postMovement({
      variantId: trackedVariant,
      delta: 5,
      note: "opening count",
    });
    expect(status).toBe(201);
    expect(data.onHand).toBe(5);
    expect(data.reason).toBe("opening_balance");

    const [level] = await admin<{ on_hand: number }[]>`
      SELECT on_hand FROM stock_levels WHERE variant_id = ${trackedVariant}`;
    expect(level!.on_hand).toBe(5);

    const audits = await admin<{ before: unknown; after: unknown }[]>`
      SELECT before, after FROM audit_log
      WHERE tenant_id = ${tenantId} AND action = 'inventory.adjusted'
        AND entity_id = ${trackedVariant}`;
    expect(audits.length).toBe(1);

    expect(received.length).toBe(1);
    expect(received[0]!.tenantId).toBe(tenantId);
    expect(received[0]!.tags).toContain(`t:${tenantId}:product:${productId}`);
  });

  it("refuses going below zero with 422, no ledger row, no purge", async () => {
    sessionToken = ownerToken;
    const before = await ledgerCount(trackedVariant);
    const { status, data } = await postMovement({
      variantId: trackedVariant,
      delta: -99,
      note: "impossible",
    });
    expect(status).toBe(422);
    expect((data.error as { code: string }).code).toBe("insufficient_stock");
    expect(await ledgerCount(trackedVariant)).toBe(before);
    expect(received.length).toBe(0);
  });

  it("replays an idempotency key: one ledger row, second response flagged", async () => {
    sessionToken = ownerToken;
    const key = "route-idem-" + randomUUID();
    const before = await ledgerCount(trackedVariant);

    const first = await postMovement({
      variantId: trackedVariant, delta: 2, note: "restock", idempotencyKey: key,
    });
    const second = await postMovement({
      variantId: trackedVariant, delta: 2, note: "restock", idempotencyKey: key,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.data.replayed).toBe(false);
    expect(second.data.replayed).toBe(true);
    expect(second.data.movementId).toBe(first.data.movementId);
    expect(await ledgerCount(trackedVariant)).toBe(before + 1);
    // The replay wrote nothing, so it must purge nothing.
    expect(received.length).toBe(1);
  });
});
