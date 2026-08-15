import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  InvalidTenantIdError,
  PLATFORM_TABLES,
  TENANT_COLUMN,
  allTables,
  closeConnections,
  currentTenantContext,
  tenantScopedTableNames,
  withPlatform,
  withTenant,
} from "../src/index";

/**
 * THE TENANT ISOLATION SUITE — PLATFORM_BLUEPRINT.md §7.4
 *
 * This is the highest-leverage test file in the codebase. It is what
 * converts "no tenant may be hardcoded, every table must be
 * tenant-scoped" from a rule people remember into a rule the build
 * enforces.
 *
 * It runs in CI on every commit. If it is ever red, nothing ships.
 * If a test here is ever deleted or skipped to make a build pass, that
 * is the moment the Phase 2 rewrite becomes inevitable.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run the isolation suite");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantA: string;
let tenantB: string;
let productA: string;
let productB: string;
let planId: string;

/**
 * Both tenants publish a product at the SAME slug.
 *
 * url_slugs is keyed (tenant_id, slug), so this is legal and will be the
 * norm — every store wants /white-shirt. It also makes the storefront's
 * central lookup, slug → entity, a genuine isolation test rather than a
 * formality.
 */
const SHARED_SLUG = "iso-white-shirt";

/**
 * `tx.execute` returns driver-level rows, so a jsonb column arrives as
 * its JSON text rather than a decoded value. Normalise so assertions
 * describe the data, not the driver.
 */
function jsonValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

/** Flattens an error chain so assertions can see the root Postgres error. */
function errorChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    parts.push(String((cur as Error).message ?? cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" ⇐ ");
}

beforeAll(async () => {
  // Fixtures are created with the migrator role, the one context
  // allowed to write across tenants.
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"test-" + randomUUID().slice(0, 8)}, 'Isolation test plan')
    RETURNING id`;
  planId = plan!.id;

  const mk = async (slug: string) => {
    const [t] = await admin<{ id: string }[]>`
      INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
      VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
      RETURNING id`;
    return t!.id;
  };

  tenantA = await mk("iso-a-" + randomUUID().slice(0, 8));
  tenantB = await mk("iso-b-" + randomUUID().slice(0, 8));

  await admin`
    INSERT INTO store_settings (tenant_id, key, value) VALUES
      (${tenantA}, 'secret', ${JSON.stringify("A-only")}::jsonb),
      (${tenantB}, 'secret', ${JSON.stringify("B-only")}::jsonb)`;

  await admin`
    INSERT INTO audit_log (id, tenant_id, actor_type, action, entity_type) VALUES
      (${randomUUID()}, ${tenantA}, 'system', 'test.a', 'test'),
      (${randomUUID()}, ${tenantB}, 'system', 'test.b', 'test')`;

  // Catalog fixtures. Without rows on both sides, the read-isolation
  // loop below passes on an empty table no matter what RLS does — the
  // test would be green and worthless the day products shipped.
  const mkProduct = async (tenantId: string, marker: string) => {
    const [p] = await admin<{ id: string }[]>`
      INSERT INTO products (id, tenant_id, title, status)
      VALUES (${randomUUID()}, ${tenantId}, ${marker}, 'active')
      RETURNING id`;

    await admin`
      INSERT INTO product_variants
        (id, tenant_id, product_id, sku, price_paise, weight_grams)
      VALUES
        (${randomUUID()}, ${tenantId}, ${p!.id}, ${marker + "-SKU"}, 19900, 500)`;

    await admin`
      INSERT INTO url_slugs (tenant_id, slug, entity_type, entity_id)
      VALUES (${tenantId}, ${SHARED_SLUG}, 'product', ${p!.id})`;

    return p!.id;
  };

  productA = await mkProduct(tenantA, "iso-product-A");
  productB = await mkProduct(tenantB, "iso-product-B");

  // Inventory fixtures: without rows on both sides, the read-isolation
  // loop passes on the three new tables no matter what RLS does.
  const mkStock = async (tenantId: string, productId: string) => {
    const [variant] = await admin<{ id: string }[]>`
      SELECT id FROM product_variants WHERE product_id = ${productId}`;
    const [loc] = await admin<{ id: string }[]>`
      INSERT INTO locations (id, tenant_id, name, is_default)
      VALUES (${randomUUID()}, ${tenantId}, 'Default', true)
      RETURNING id`;
    await admin`
      INSERT INTO stock_movements (id, tenant_id, variant_id, location_id, delta, reason)
      VALUES (${randomUUID()}, ${tenantId}, ${variant!.id}, ${loc!.id}, 5, 'opening_balance')`;
    await admin`
      INSERT INTO stock_levels (tenant_id, variant_id, location_id, on_hand)
      VALUES (${tenantId}, ${variant!.id}, ${loc!.id}, 5)`;
    await admin`
      INSERT INTO stock_reservations
        (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
      VALUES (${randomUUID()}, ${tenantId}, ${variant!.id}, ${loc!.id}, 1,
              'checkout', ${randomUUID()}, now() + interval '15 minutes')`;
  };
  await mkStock(tenantA, productA);
  await mkStock(tenantB, productB);
});

afterAll(async () => {
  await admin`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
  await admin`DELETE FROM plans WHERE id = ${planId}`;
  await admin.end({ timeout: 5 });
  await closeConnections();
});

// ───────────────────────────────────────────────────────────────
// Test 4 from the blueprint, listed first because it is the one that
// keeps the other three honest as the schema grows. Every future table
// — products, orders, customers — is covered the moment it is added,
// with no test written for it.
// ───────────────────────────────────────────────────────────────
describe("schema coverage: no table escapes a deliberate decision", () => {
  it("every public table is either RLS-protected or explicitly justified", async () => {
    const rows = await admin<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`;

    const unjustified: string[] = [];
    const missingColumn: string[] = [];
    const unprotected: string[] = [];

    for (const row of rows) {
      // Default-deny: a table is tenant-scoped unless explicitly excused.
      if (row.relname in PLATFORM_TABLES) continue;

      const known = allTables().find((t) => t.name === row.relname);
      if (!known) {
        unjustified.push(row.relname);
        continue;
      }
      if (!known.columns.includes(TENANT_COLUMN)) {
        missingColumn.push(row.relname);
        continue;
      }
      if (!row.relrowsecurity || !row.relforcerowsecurity) unprotected.push(row.relname);
    }

    expect(
      unjustified,
      `Table(s) present in the database but absent from the Drizzle schema. ` +
        `Add them to the schema or to PLATFORM_TABLES with a justification.`,
    ).toEqual([]);

    expect(
      missingColumn,
      `Table(s) with no ${TENANT_COLUMN} and no entry in PLATFORM_TABLES. ` +
        `Add the column, or add a written justification to packages/db/src/rls.ts.`,
    ).toEqual([]);

    expect(
      unprotected,
      `Tenant-scoped table(s) missing ENABLE + FORCE row level security. ` +
        `Run \`pnpm db:migrate\` to re-apply generated policies.`,
    ).toEqual([]);
  });

  it("control-plane tables are genuinely exempt, not accidentally unprotected", async () => {
    // Every PLATFORM_TABLES entry must correspond to a real table and
    // carry a non-empty justification, so the allowlist cannot rot into
    // a dumping ground for tables someone could not be bothered to scope.
    const real = new Set(allTables().map((t) => t.name));
    for (const [table, reason] of Object.entries(PLATFORM_TABLES)) {
      if (table === "__drizzle_migrations") continue;
      expect(real.has(table), `PLATFORM_TABLES lists unknown table "${table}"`).toBe(true);
      expect(reason.length, `PLATFORM_TABLES["${table}"] has no justification`).toBeGreaterThan(30);
    }
  });

  it("every tenant-scoped table carries the tenant_isolation policy", async () => {
    const policies = await admin<{ tablename: string; policyname: string }[]>`
      SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'`;

    const withPolicy = new Set(
      policies.filter((p) => p.policyname === "tenant_isolation").map((p) => p.tablename),
    );

    const missing = tenantScopedTableNames().filter((t) => !withPolicy.has(t));
    expect(missing, "Tenant-scoped table(s) missing tenant_isolation policy").toEqual([]);
  });

  it("the application role holds no BYPASSRLS privilege", async () => {
    const role = process.env.DB_APP_ROLE ?? "app_user";
    const [r] = await admin<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = ${role}`;

    expect(r, `Role ${role} does not exist`).toBeDefined();
    // A single BYPASSRLS grant silently disables every policy above.
    expect(r!.rolbypassrls).toBe(false);
    expect(r!.rolsuper).toBe(false);
  });

  it.each(["audit_log", "stock_movements"])(
    "%s is append-only for the application role",
    async (table) => {
      const role = process.env.DB_APP_ROLE ?? "app_user";
      const [r] = await admin<{ upd: boolean; del: boolean; ins: boolean }[]>`
        SELECT has_table_privilege(${role}, ${table}, 'UPDATE') AS upd,
               has_table_privilege(${role}, ${table}, 'DELETE') AS del,
               has_table_privilege(${role}, ${table}, 'INSERT') AS ins`;

      // A history the application can rewrite is not a history.
      expect(r!.upd).toBe(false);
      expect(r!.del).toBe(false);
      expect(r!.ins).toBe(true);
    },
  );
});

// ───────────────────────────────────────────────────────────────
// Test 1: reads
// ───────────────────────────────────────────────────────────────
describe("read isolation", () => {
  it("tenant A sees none of tenant B's rows, on every tenant-scoped table", async () => {
    for (const table of tenantScopedTableNames()) {
      const leaked = await withTenant(tenantA, async (tx) => {
        const rows = await tx.execute(
          // Table name comes from our own schema metadata, never user input.
          `SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id = '${tenantB}'`,
        );
        return (rows as unknown as { n: number }[])[0]?.n ?? -1;
      });

      expect(leaked, `LEAK: tenant A could read tenant B rows in "${table}"`).toBe(0);
    }
  });

  it("tenant A can read its own rows", async () => {
    const own = await withTenant(tenantA, async (tx) => {
      const rows = await tx.execute(`SELECT count(*)::int AS n FROM store_settings`);
      return (rows as unknown as { n: number }[])[0]?.n ?? 0;
    });
    expect(own).toBeGreaterThan(0);
  });

  it("an unfiltered SELECT still returns only the active tenant's rows", async () => {
    // The point of RLS: even a query that forgets to filter is safe.
    const values = await withTenant(tenantB, async (tx) => {
      const rows = await tx.execute(`SELECT value FROM store_settings WHERE key = 'secret'`);
      return (rows as unknown as { value: unknown }[]).map((r) => jsonValue(r.value));
    });
    expect(values).toEqual(["B-only"]);
  });
});

// ───────────────────────────────────────────────────────────────
// Catalog. The read-isolation loop above already covers these tables
// generically; these assert the two catalog-specific paths where a
// mistake would be invisible rather than loud.
// ───────────────────────────────────────────────────────────────
describe("catalog isolation", () => {
  it("the same slug resolves to a different product for each tenant", async () => {
    // This is the storefront's first query on every request. If it ever
    // crossed tenants, one merchant's product page would render on
    // another merchant's domain — under their branding, at their URL.
    const resolve = (tenantId: string) =>
      withTenant(tenantId, async (tx) => {
        const rows = await tx.execute(
          `SELECT entity_id FROM url_slugs
           WHERE slug = '${SHARED_SLUG}' AND is_canonical`,
        );
        return (rows as unknown as { entity_id: string }[]).map((r) => r.entity_id);
      });

    expect(await resolve(tenantA)).toEqual([productA]);
    expect(await resolve(tenantB)).toEqual([productB]);
  });

  it("a variant cannot be read through another tenant's product id", async () => {
    // The dangerous shape is an id arriving from a URL or a request
    // body. Nothing filters it by tenant in the query, so RLS is the
    // only thing standing between a guessed id and another store's data.
    const rows = await withTenant(tenantA, async (tx) => {
      const r = await tx.execute(
        `SELECT sku, price_paise FROM product_variants WHERE product_id = '${productB}'`,
      );
      return r as unknown as unknown[];
    });

    expect(rows, "A variant leaked across tenants via a guessed product id").toEqual([]);
  });

  it("full-text search returns only the searching tenant's products", async () => {
    // Search bypasses every explicit tenant filter a developer might
    // write, because the WHERE clause is about the query text.
    const search = (tenantId: string) =>
      withTenant(tenantId, async (tx) => {
        const rows = await tx.execute(
          `SELECT title FROM products
           WHERE search_vector @@ plainto_tsquery('english', 'iso product')`,
        );
        return (rows as unknown as { title: string }[]).map((r) => r.title);
      });

    // Asserting both sides matters: it shows the query genuinely matches
    // BOTH fixtures, so tenant A seeing one row is isolation doing its
    // job rather than the tsquery quietly matching nothing.
    expect(await search(tenantA)).toEqual(["iso-product-A"]);
    expect(await search(tenantB)).toEqual(["iso-product-B"]);
  });
});

// ───────────────────────────────────────────────────────────────
// Test 2: writes — a forged tenant_id must be rejected
// ───────────────────────────────────────────────────────────────
describe("write isolation", () => {
  it("cannot INSERT a row belonging to another tenant", async () => {
    let caught: unknown;
    try {
      await withTenant(tenantA, async (tx) => {
        await tx.execute(
          `INSERT INTO store_settings (tenant_id, key, value)
           VALUES ('${tenantB}', 'forged', '"pwned"'::jsonb)`,
        );
      });
    } catch (err) {
      caught = err;
    }

    // Assert on the ROOT cause, not the ORM's wrapper message — and
    // assert specifically on RLS, so this test cannot pass because the
    // insert happened to fail for some unrelated reason.
    expect(caught, "WITH CHECK did not block a cross-tenant INSERT").toBeDefined();
    expect(errorChain(caught)).toMatch(/row-level security/i);

    // The assertion that actually matters: nothing was written.
    const forged = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM store_settings
      WHERE tenant_id = ${tenantB} AND key = 'forged'`;
    expect(forged[0]?.n ?? -1).toBe(0);
  });

  it("cannot UPDATE another tenant's row", async () => {
    const affected = await withTenant(tenantA, async (tx) => {
      const rows = await tx.execute(
        `UPDATE store_settings SET value = '"tampered"'::jsonb
         WHERE tenant_id = '${tenantB}' RETURNING key`,
      );
      return (rows as unknown as unknown[]).length;
    });
    expect(affected, "UPDATE crossed a tenant boundary").toBe(0);

    const check = await admin<{ value: unknown }[]>`
      SELECT value FROM store_settings WHERE tenant_id = ${tenantB} AND key = 'secret'`;
    expect(jsonValue(check[0]?.value)).toBe("B-only");
  });

  it("cannot DELETE another tenant's row", async () => {
    await withTenant(tenantA, async (tx) => {
      await tx.execute(`DELETE FROM store_settings WHERE tenant_id = '${tenantB}'`);
    });

    const remaining = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM store_settings WHERE tenant_id = ${tenantB}`;
    expect(remaining[0]?.n ?? 0, "DELETE crossed a tenant boundary").toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────
// Test 3: context handling — the connection-pool leak class of bug
// ───────────────────────────────────────────────────────────────
describe("tenant context handling", () => {
  it("fails closed: no context means no rows, not an error and not everything", async () => {
    const n = await withPlatform(async (tx) => {
      const rows = await tx.execute(`SELECT count(*)::int AS n FROM store_settings`);
      return (rows as unknown as { n: number }[])[0]?.n ?? -1;
    });
    expect(n, "Tenant-scoped data was readable with no tenant context").toBe(0);
  });

  it("context does not survive the transaction (the pooled-connection leak)", async () => {
    // This is the bug SET LOCAL exists to prevent: a session-level SET
    // would leak tenant A's context to whichever request next borrows
    // this connection. Loop so the pool hands back a used connection.
    for (let i = 0; i < 25; i++) {
      await withTenant(tenantA, async (tx) => {
        await tx.execute(`SELECT 1`);
      });

      const leaked = await withPlatform((tx) => currentTenantContext(tx));
      expect(leaked ?? "", `Tenant context leaked across transactions on iteration ${i}`).toBe("");
    }
  });

  it("concurrent transactions do not observe each other's tenant", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const target = i % 2 === 0 ? tenantA : tenantB;
        return withTenant(target, async (tx) => {
          // Give the scheduler a chance to interleave the transactions.
          await tx.execute(`SELECT pg_sleep(0.01)`);
          const seen = await currentTenantContext(tx);
          return { expected: target, seen };
        });
      }),
    );

    for (const r of results) expect(r.seen).toBe(r.expected);
  });

  it("rejects a malformed tenant id before it reaches the database", async () => {
    for (const bad of ["", "not-a-uuid", "' OR 1=1 --", null, undefined, 42]) {
      await expect(
        withTenant(bad as unknown as string, async () => "should not run"),
      ).rejects.toThrow(InvalidTenantIdError);
    }
  });

  it("a well-formed but unknown tenant id yields no data", async () => {
    const n = await withTenant(randomUUID(), async (tx) => {
      const rows = await tx.execute(`SELECT count(*)::int AS n FROM store_settings`);
      return (rows as unknown as { n: number }[])[0]?.n ?? -1;
    });
    expect(n).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────
// Test 5: background jobs carry tenancy in the payload
// ───────────────────────────────────────────────────────────────
describe("background job isolation", () => {
  it("a job scoped to tenant A cannot read tenant B", async () => {
    // Mirrors the worker contract: every job payload carries tenantId,
    // and the handler's first act is withTenant(job.data.tenantId).
    const handler = async (job: { tenantId: string }) =>
      withTenant(job.tenantId, async (tx) => {
        const rows = await tx.execute(`SELECT key, value FROM store_settings`);
        return (rows as unknown as { value: unknown }[]).map((r) => jsonValue(r.value));
      });

    expect(await handler({ tenantId: tenantA })).toEqual(["A-only"]);
    expect(await handler({ tenantId: tenantB })).toEqual(["B-only"]);
  });
});
