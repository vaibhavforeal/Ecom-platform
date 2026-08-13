import { createHash, randomUUID } from "node:crypto";

import { closeRedis } from "@platform/core";
import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Caddy's on-demand TLS ask endpoint against real Postgres.
 *
 * The critical property: the TLS_ASK_SECRET auth must fail CLOSED in
 * production when no secret is configured — the fail-open branch that
 * this task closes was invisible because no test ever exercised it.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let testPlanId: string;
let testTenantId: string;
let verifiedDomain: string;

async function makeTenantWithVerifiedDomain(): Promise<{
  tenantId: string;
  domain: string;
  planId: string;
}> {
  const slug = "tls-" + randomUUID().slice(0, 12);
  const domain = slug + ".example";

  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"tls-" + randomUUID().slice(0, 8)}, 'TLS test plan')
    RETURNING id`;

  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;

  // What isDomainVerifiedForTls reads: a verified domain row.
  await admin`
    INSERT INTO domains (id, tenant_id, hostname, verified_at, is_primary)
    VALUES (${randomUUID()}, ${tenant!.id}, ${domain}, now(), true)`;

  return { tenantId: tenant!.id, domain, planId: plan!.id };
}

beforeAll(async () => {
  const fixture = await makeTenantWithVerifiedDomain();
  testTenantId = fixture.tenantId;
  verifiedDomain = fixture.domain;
  testPlanId = fixture.planId;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  // Cleanup: tenants first (cascades to domains and members), then plans.
  await admin`DELETE FROM tenants WHERE id = ${testTenantId}`;
  await admin`DELETE FROM plans WHERE id = ${testPlanId}`;
  await closeRedis();
  await admin.end();
  await closeConnections();
});

const { GET } = await import("../src/app/api/internal/verify-domain/route");

describe("GET /api/internal/verify-domain", () => {
  it("200s a verified domain when the ask secret matches", async () => {
    vi.stubEnv("TLS_ASK_SECRET", "ask_secret_under_test");
    const res = await GET(
      new Request(
        `http://console/api/internal/verify-domain?domain=${verifiedDomain}&secret=ask_secret_under_test`,
      ),
    );
    expect(res.status).toBe(200);
  });

  it("403s a wrong secret without consulting domain state", async () => {
    vi.stubEnv("TLS_ASK_SECRET", "ask_secret_under_test");
    const res = await GET(
      new Request(
        `http://console/api/internal/verify-domain?domain=${verifiedDomain}&secret=wrong`,
      ),
    );
    expect(res.status).toBe(403);
  });

  it("fails CLOSED outside development and test when no secret is configured", async () => {
    vi.stubEnv("TLS_ASK_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(
      new Request(`http://console/api/internal/verify-domain?domain=${verifiedDomain}`),
    );
    expect(res.status).toBe(403);
  });

  it("stays usable in development with no secret configured", async () => {
    vi.stubEnv("TLS_ASK_SECRET", "");
    vi.stubEnv("NODE_ENV", "development");
    const res = await GET(
      new Request(`http://console/api/internal/verify-domain?domain=${verifiedDomain}`),
    );
    expect(res.status).toBe(200);
  });

  it("still 403s an unverified domain even with a valid secret", async () => {
    vi.stubEnv("TLS_ASK_SECRET", "ask_secret_under_test");
    const res = await GET(
      new Request(
        `http://console/api/internal/verify-domain?domain=attacker.example&secret=ask_secret_under_test`,
      ),
    );
    expect(res.status).toBe(403);
  });
});
