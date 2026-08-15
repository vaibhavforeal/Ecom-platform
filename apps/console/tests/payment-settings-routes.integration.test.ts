import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { closeRedis, invalidateHostCache, platformKey, redis } from "@platform/core";
import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * /api/settings/payments (+ /test-event) against real PostgreSQL.
 *
 * The properties pinned here are the ones a careless edit regresses
 * silently: secrets travel IN and never OUT (fingerprint only, D7), the
 * webhook URL is served for copying, permission is payments:write
 * (owner-only), and the send-test-event button drives the REAL
 * storefront webhook route end to end over HTTP (D19) — mock-signed
 * body, HMAC verified by the route, evidence row committed by the
 * route's own TX-1.
 */

let sessionToken: string | undefined;
/** Host the storefront-route bridge presents via next/headers. */
let forwardedHost: string | null = null;

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "console_session" && sessionToken ? { name, value: sessionToken } : undefined,
    }),
  headers: () =>
    Promise.resolve(
      new Headers(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}),
    ),
}));

const { GET: getSettingsRoute, PUT: putSettingsRoute } = await import(
  "../src/app/api/settings/payments/route"
);
const { POST: testEventRoute } = await import(
  "../src/app/api/settings/payments/test-event/route"
);

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantA: string;
let hostA: string;
let ownerToken: string;
let managerToken: string;

const createdTenants = new Set<string>();
const createdUsers = new Set<string>();
const createdPlans = new Set<string>();

let savedMasterKey: string | undefined;
let savedStorefrontOrigin: string | undefined;
let webhookBridge: Server | undefined;

const KEY_SECRET = "mock_key_secret_plain_77";
const WEBHOOK_SECRET = "mock_webhook_secret_plain_88";

async function makeTenant(): Promise<{ id: string; hostname: string }> {
  const slug = "payset-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"payset-" + randomUUID().slice(0, 8)}, 'Payment settings test plan')
    RETURNING id`;
  createdPlans.add(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  createdTenants.add(tenant!.id);
  // A verified primary domain: the webhook URL is built on it, and the
  // storefront route resolves the tenant by it.
  const hostname = `${slug}.payments-test.localhost`;
  await admin`
    INSERT INTO domains (id, tenant_id, hostname, is_primary, verified_at)
    VALUES (${randomUUID()}, ${tenant!.id}, ${hostname}, true, now())`;
  return { id: tenant!.id, hostname };
}

async function makeSession(tenantId: string, role: string): Promise<string> {
  const userId = randomUUID();
  createdUsers.add(userId);
  const phone = "+9196" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userId}, ${phone}, 'Payments test')`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, role, accepted_at)
    VALUES (${tenantId}, ${userId}, ${role}, now())`;
  const token = randomUUID() + randomUUID();
  await admin`
    INSERT INTO sessions (id, token_hash, user_id, tenant_id, expires_at, idle_expires_at)
    VALUES (${randomUUID()}, ${createHash("sha256").update(token).digest("hex")},
            ${userId}, ${tenantId}, now() + interval '1 day', now() + interval '1 day')`;
  return token;
}

type RouteResult = { status: number; data: Record<string, unknown> };

async function putSettings(body: unknown): Promise<RouteResult> {
  const response = await putSettingsRoute(
    new Request("http://console.test/api/settings/payments", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function getSettings(): Promise<RouteResult> {
  const response = await getSettingsRoute();
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function postTestEvent(): Promise<RouteResult> {
  const response = await testEventRoute(
    new Request("http://console.test/api/settings/payments/test-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

function validPayload(): Record<string, unknown> {
  return {
    providerCode: "mock",
    publicKeyId: "mock_pub_key_01",
    keySecret: KEY_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    isEnabled: true,
  };
}

/**
 * A real HTTP server bridging to the REAL storefront webhook route
 * handler, so the console route's outbound POST travels the same wire it
 * would in production. The route module is imported by variable path:
 * it belongs to lot B-INT and this suite is authored before it lands —
 * typecheck must not depend on it, the central integration run does.
 */
async function startWebhookBridge(): Promise<string> {
  const storefrontWebhookModule = "../../storefront/src/app/api/payments/webhook/route";
  const mod = (await import(storefrontWebhookModule)) as {
    POST: (req: Request) => Promise<Response>;
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      void (async () => {
        // The storefront resolves its tenant from x-forwarded-host via
        // next/headers — surface this request's value through the mock.
        forwardedHost = (req.headers["x-forwarded-host"] as string | undefined) ?? null;
        try {
          const headers = new Headers();
          for (const name of [
            "content-type",
            "x-razorpay-signature",
            "x-razorpay-event-id",
            "x-forwarded-host",
          ]) {
            const value = req.headers[name];
            if (typeof value === "string") headers.set(name, value);
          }
          const response = await mod.POST(
            new Request(`http://storefront.internal${req.url ?? "/"}`, {
              method: req.method ?? "POST",
              headers,
              body: new Uint8Array(Buffer.concat(chunks)),
            }),
          );
          res.statusCode = response.status;
          res.end(await response.text());
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        } finally {
          forwardedHost = null;
        }
      })();
    });
  });

  webhookBridge = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  savedMasterKey = process.env.CREDENTIALS_MASTER_KEY;
  if (!savedMasterKey) {
    process.env.CREDENTIALS_MASTER_KEY = randomBytes(32).toString("base64");
  }
  savedStorefrontOrigin = process.env.STOREFRONT_INTERNAL_ORIGIN;

  const a = await makeTenant();
  tenantA = a.id;
  hostA = a.hostname;
  ownerToken = await makeSession(tenantA, "owner");
  managerToken = await makeSession(tenantA, "manager");
});

afterEach(() => {
  sessionToken = undefined;
});

afterAll(async () => {
  // Env restored BEFORE the pools close (the worker-suite lesson).
  if (savedMasterKey === undefined) delete process.env.CREDENTIALS_MASTER_KEY;
  else process.env.CREDENTIALS_MASTER_KEY = savedMasterKey;
  if (savedStorefrontOrigin === undefined) delete process.env.STOREFRONT_INTERNAL_ORIGIN;
  else process.env.STOREFRONT_INTERNAL_ORIGIN = savedStorefrontOrigin;

  if (webhookBridge) await new Promise<void>((resolve) => webhookBridge!.close(() => resolve()));

  // primaryHostname and resolveTenantByHost warm platform Redis keys.
  await redis().del(platformKey("primary-host", tenantA));
  await invalidateHostCache([hostA]);
  await closeRedis();

  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdUsers) await admin`DELETE FROM users WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  await closeConnections();
});

describe("/api/settings/payments", () => {
  it("refuses unauthenticated requests with 401 and stores nothing", async () => {
    const put = await putSettings(validPayload());
    expect(put.status).toBe(401);
    const get = await getSettings();
    expect(get.status).toBe(401);
    const rows = await admin`SELECT id FROM payment_accounts WHERE tenant_id = ${tenantA}`;
    expect(rows.length).toBe(0);
  });

  it("refuses a manager with 403 — payments:write is owner-only", async () => {
    sessionToken = managerToken;
    const { status, data } = await putSettings(validPayload());
    expect(status).toBe(403);
    expect((data.error as { code: string }).code).toBe("forbidden");
    const rows = await admin`SELECT id FROM payment_accounts WHERE tenant_id = ${tenantA}`;
    expect(rows.length).toBe(0);
  });

  it("422s a payload missing the webhook secret, field-addressed", async () => {
    sessionToken = ownerToken;
    const { webhookSecret: _omitted, ...incomplete } = validPayload();
    const { status, data } = await putSettings(incomplete);
    expect(status).toBe(422);
    const error = data.error as { code: string; details: { issues: { path: string }[] } };
    expect(error.code).toBe("invalid_payload");
    expect(error.details.issues.some((i) => i.path === "webhookSecret")).toBe(true);
  });

  it("PUT seals both secrets and echoes NEITHER — fingerprint only, sealed rows in the DB", async () => {
    sessionToken = ownerToken;
    const { status, data } = await putSettings(validPayload());
    expect(status).toBe(200);

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(KEY_SECRET);
    expect(serialized).not.toContain(WEBHOOK_SECRET);

    const account = data.account as {
      providerCode: string;
      publicKeyId: string;
      credentialFingerprint: string;
      isEnabled: boolean;
    };
    expect(account.providerCode).toBe("mock");
    expect(account.publicKeyId).toBe("mock_pub_key_01");
    expect(account.credentialFingerprint).toMatch(/^••/);
    expect(account.isEnabled).toBe(true);
    expect(data.webhookUrl).toBe(`https://${hostA}/api/payments/webhook`);

    const [row] = await admin<
      { sealed_credentials: string; sealed_webhook_secret: string }[]
    >`SELECT sealed_credentials, sealed_webhook_secret FROM payment_accounts
      WHERE tenant_id = ${tenantA} AND provider_code = 'mock'`;
    expect(row).toBeDefined();
    expect(row!.sealed_credentials).not.toContain(KEY_SECRET);
    expect(row!.sealed_webhook_secret).not.toContain(WEBHOOK_SECRET);
    expect(row!.sealed_credentials).not.toBe(row!.sealed_webhook_secret);
  });

  it("GET serves the fingerprint view and the copyable webhook URL — never a secret", async () => {
    sessionToken = ownerToken;
    const { status, data } = await getSettings();
    expect(status).toBe(200);

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(KEY_SECRET);
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect(serialized).not.toContain("sealed");

    const account = data.account as { credentialFingerprint: string; publicKeyId: string };
    expect(account.credentialFingerprint).toMatch(/^••/);
    expect(account.publicKeyId).toBe("mock_pub_key_01");
    expect(data.webhookUrl).toBe(`https://${hostA}/api/payments/webhook`);
  });

  it("send-test-event drives the REAL storefront webhook route end to end (D19)", async () => {
    process.env.STOREFRONT_INTERNAL_ORIGIN = await startWebhookBridge();

    // The enabled mock account from the PUT above signs the test event.
    sessionToken = ownerToken;
    const { status, data } = await postTestEvent();
    expect(status).toBe(200);
    expect(data.delivered).toBe(true);
    expect(typeof data.eventId).toBe("string");
    expect(data.webhookUrl).toBe(`https://${hostA}/api/payments/webhook`);

    // The evidence row landed through the route's own TX-1: HMAC
    // verified, tenant resolved by Host, dedupe key present.
    const rows = await admin<
      { provider_code: string; event_type: string }[]
    >`SELECT provider_code, event_type FROM payment_webhook_events
      WHERE tenant_id = ${tenantA} AND gateway_event_id = ${data.eventId as string}`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.provider_code).toBe("mock");
    expect(rows[0]!.event_type).toBe("payment.captured");
  });
});
