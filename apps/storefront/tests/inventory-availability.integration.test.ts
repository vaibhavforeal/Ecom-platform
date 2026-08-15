import { randomUUID } from "node:crypto";

import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installNextDataCache, runDynamicRender } from "./next-cache-harness";

/**
 * Inventory ledger integration — storefront availability.
 *
 * The PDP now reflects the inventory ledger: variants gain
 * `tracksInventory` and `available`, the picker greys sold-out options,
 * and JSON-LD availability flips when every active variant is out.
 */

await installNextDataCache();

const { getCachedProduct } = await import("../src/lib/catalog");
const { productJsonLd } = await import("../src/lib/seo");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

const TRACKED_SKU = "INV-TRACKED";
const UNTRACKED_SKU = "INV-UNTRACKED";

let tenantId: string;
let planId: string;
let productId: string;

beforeAll(async () => {
  const slug = "inv-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"inv-" + randomUUID().slice(0, 8)}, 'Inventory test plan')
    RETURNING id`;
  planId = plan!.id;
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${planId}, 'active')
    RETURNING id`;
  tenantId = tenant!.id;

  // Product with two variants: one tracked at zero, one untracked.
  productId = randomUUID();
  await admin`
    INSERT INTO products (id, tenant_id, title, description, status, published_at)
    VALUES (${productId}, ${tenantId}, 'Inventory Test Product',
            '<p>A product with inventory tracking</p>', 'active', now())`;
  await admin`
    INSERT INTO url_slugs (tenant_id, slug, entity_type, entity_id)
    VALUES (${tenantId}, 'inventory-test-product', 'product', ${productId})`;

  // Tracked variant with distinct options (Size: M), tracks_inventory = true, stock at 0
  const trackedVariantId = randomUUID();
  await admin`
    INSERT INTO product_variants (id, tenant_id, product_id, sku, price_paise, weight_grams, options, tracks_inventory)
    VALUES (${trackedVariantId}, ${tenantId}, ${productId}, ${TRACKED_SKU}, 99900, 100,
            ${'{"Size":"M"}'}::text::jsonb, true)`;

  // Create location and stock level at 0 for tracked variant
  const [loc] = await admin<{ id: string }[]>`
    INSERT INTO locations (id, tenant_id, name, is_default)
    VALUES (${randomUUID()}, ${tenantId}, 'Default', true)
    RETURNING id`;
  await admin`
    INSERT INTO stock_levels (tenant_id, variant_id, location_id, on_hand)
    VALUES (${tenantId}, ${trackedVariantId}, ${loc!.id}, 0)`;

  // Untracked variant with distinct options (Size: L)
  await admin`
    INSERT INTO product_variants (id, tenant_id, product_id, sku, price_paise, weight_grams, options, tracks_inventory)
    VALUES (${randomUUID()}, ${tenantId}, ${productId}, ${UNTRACKED_SKU}, 99900, 100,
            ${'{"Size":"L"}'}::text::jsonb, false)`;
});

afterAll(async () => {
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`;
  await admin`DELETE FROM plans WHERE id = ${planId}`;
  await admin.end({ timeout: 5 });
  await closeConnections();
});

describe("inventory ledger integration on storefront", () => {
  it("the PDP carries per-variant availability and JSON-LD reflects in-stock state", async () => {
    // 1. The cached PDP read carries availability.
    const product = await runDynamicRender(() => getCachedProduct(tenantId, productId));
    const tracked = product!.variants.find((v) => v.sku === TRACKED_SKU)!;
    const untracked = product!.variants.find((v) => v.sku === UNTRACKED_SKU)!;
    expect(tracked.tracksInventory).toBe(true);
    expect(tracked.available).toBe(0);
    expect(untracked.tracksInventory).toBe(false);
    expect(untracked.available).toBeNull();

    // 2. JSON-LD: with BOTH variants active but only the untracked one in
    // stock, the product is InStock; with the untracked variant filtered
    // out (pass a variants array holding only the tracked-at-zero one),
    // availability flips to OutOfStock.
    const ld = productJsonLd({ product: product!, url: "https://x.test/p", organizationName: "X", imageUrls: [] });
    expect(JSON.stringify(ld)).toContain("schema.org/InStock");

    const soldOut = { ...product!, variants: product!.variants.filter((v) => v.tracksInventory) };
    const ldOut = productJsonLd({ product: soldOut, url: "https://x.test/p", organizationName: "X", imageUrls: [] });
    expect(JSON.stringify(ldOut)).toContain("schema.org/OutOfStock");
  });
});
