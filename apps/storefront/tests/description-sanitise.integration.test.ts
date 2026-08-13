import { randomUUID } from "node:crypto";

import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installNextDataCache, runDynamicRender } from "./next-cache-harness";

/**
 * Defence-in-depth sanitisation at the cache boundary.
 *
 * The write layer sanitises descriptions on the way in — every row written
 * through the console arrives clean. But defence in depth means that a row
 * that bypassed the write layer — psql, a restored dump, a seed script —
 * must still never reach dangerouslySetInnerHTML.
 *
 * The sanitiser runs at the cache fill now, not per request: same
 * protection (every render path goes through the cache), amortised cost
 * (one pass per 300s entry, not per visitor).
 *
 * The fixture here is a HOSTILE description written straight to the column
 * via a bare postgres() client — deliberately bypassing the write layer,
 * because that bypass is exactly what the defence-in-depth pass exists for.
 */

await installNextDataCache();

const { getCachedProduct } = await import("../src/lib/catalog");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantId: string;
let planId: string;
let productId: string;

beforeAll(async () => {
  const slug = "sf-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"sf-" + randomUUID().slice(0, 8)}, 'Sanitise test plan')
    RETURNING id`;
  planId = plan!.id;
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${planId}, 'active')
    RETURNING id`;
  tenantId = tenant!.id;

  // A product with a HOSTILE description written straight to the column,
  // bypassing the write layer — simulating psql, a restored dump, or a
  // backfill that forgot to sanitise.
  productId = randomUUID();
  await admin`
    INSERT INTO products (id, tenant_id, title, description, status, published_at)
    VALUES (${productId}, ${tenantId}, 'Hostile Product',
            '<p>ok</p><script>alert(1)</script>', 'active', now())`;
  await admin`
    INSERT INTO url_slugs (tenant_id, slug, entity_type, entity_id)
    VALUES (${tenantId}, 'hostile-product', 'product', ${productId})`;
  await admin`
    INSERT INTO product_variants (id, tenant_id, product_id, sku, price_paise, weight_grams)
    VALUES (${randomUUID()}, ${tenantId}, ${productId}, 'HOSTILE-SKU', 99900, 100)`;
});

afterAll(async () => {
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`;
  await admin`DELETE FROM plans WHERE id = ${planId}`;
  await admin.end({ timeout: 5 });
  await closeConnections();
});

describe("description defence-in-depth at the cache boundary", () => {
  it("a visitor never receives markup the sanitiser would strip", async () => {
    const detail = await runDynamicRender(() => getCachedProduct(tenantId, productId));
    expect(detail!.description).toContain("<p>ok</p>");
    expect(detail!.description).not.toContain("<script>");
  });
});
