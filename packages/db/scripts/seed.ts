import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v7 as uuidv7 } from "uuid";

import * as schema from "../src/schema/index";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

/**
 * Development fixtures: TWO tenants on TWO hostnames.
 *
 * Two, not one, on purpose. A single-tenant seed cannot demonstrate
 * isolation, and a platform that has only ever run with one tenant has
 * never actually exercised the property the whole architecture rests on.
 * From day one, local development runs multi-tenant.
 *
 * Both tenants are deliberately fictional. No real merchant, domain or
 * tax identity belongs in seed data — production tenants are created
 * through onboarding, never through a script.
 *
 * Runs as the migrator role because it writes across tenant boundaries —
 * the one legitimate case for bypassing RLS.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRATOR;
  if (!url) throw new Error("DATABASE_URL_MIGRATOR is not set");

  const root = process.env.STOREFRONT_ROOT_DOMAIN ?? "localhost:3000";
  const rootHost = root.split(":")[0] ?? "localhost";

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql, { schema });

  try {
    const [devPlan] = await db
      .insert(schema.plans)
      .values({
        id: uuidv7(),
        code: "development",
        name: "Development (unlimited)",
        pricePaiseMonthly: 0,
        isPublic: false,
        limits: { orders: null, products: null, staff: null },
      })
      .onConflictDoUpdate({
        target: schema.plans.code,
        set: { name: "Development (unlimited)" },
      })
      .returning();

    if (!devPlan) throw new Error("Failed to seed plan");

    // Two unrelated fictional merchants. The isolation suite asserts
    // that neither can observe the other.
    const acme = await upsertTenant(db, {
      slug: "acme",
      legalName: "Acme Retail Private Limited",
      displayName: "Acme Retail",
      planId: devPlan.id,
      status: "active",
      taxRegistrationType: "regular",
      hostnames: [`acme.${rootHost}`],
    });

    const globex = await upsertTenant(db, {
      slug: "globex",
      legalName: "Globex Trading Company",
      displayName: "Globex Trading",
      planId: devPlan.id,
      status: "trial",
      taxRegistrationType: "unregistered",
      hostnames: [`globex.${rootHost}`],
    });

    // Tenant-scoped rows with deliberately different values, so a
    // cross-tenant leak shows up as wrong content rather than no content.
    await db
      .insert(schema.storeSettings)
      .values([
        { tenantId: acme, key: "storefront.tagline", value: "Everything, delivered." },
        { tenantId: acme, key: "payments.advance_pct", value: 20 },
        { tenantId: globex, key: "storefront.tagline", value: "Trade without friction." },
        { tenantId: globex, key: "payments.advance_pct", value: 50 },
      ])
      .onConflictDoNothing();

    // Two unrelated catalogs. As with the settings above, the values
    // differ so a cross-tenant leak surfaces as *wrong* content on the
    // page rather than as an empty one — an empty storefront reads as a
    // bug in the query; a torque wrench on a clothing store does not.
    await seedCatalog(db, acme, ACME_CATALOG);
    await seedCatalog(db, globex, GLOBEX_CATALOG);

    console.log("\n✔ Seed complete.\n");
    console.log(`  Acme Retail     →  http://acme.${root}`);
    console.log(`  Globex Trading  →  http://globex.${root}`);
    console.log(`\n  *.localhost resolves to 127.0.0.1 in Chrome/Firefox/Safari,`);
    console.log(`  so both hosts work immediately with no hosts-file edit.\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

type SeedTenant = {
  slug: string;
  legalName: string;
  displayName: string;
  planId: string;
  status: schema.TenantStatus;
  taxRegistrationType: schema.TaxRegistrationType;
  hostnames: string[];
};

async function upsertTenant(
  db: ReturnType<typeof drizzle>,
  spec: SeedTenant,
): Promise<string> {
  const [tenant] = await db
    .insert(schema.tenants)
    .values({
      id: uuidv7(),
      slug: spec.slug,
      legalName: spec.legalName,
      displayName: spec.displayName,
      planId: spec.planId,
      status: spec.status,
      taxRegistrationType: spec.taxRegistrationType,
    })
    .onConflictDoUpdate({
      target: schema.tenants.slug,
      set: { displayName: spec.displayName, updatedAt: new Date() },
    })
    .returning();

  if (!tenant) throw new Error(`Failed to seed tenant ${spec.slug}`);

  for (const [i, hostname] of spec.hostnames.entries()) {
    await db
      .insert(schema.domains)
      .values({
        id: uuidv7(),
        tenantId: tenant.id,
        hostname,
        isPrimary: i === 0,
        // Pre-verified: these are local development hostnames. Real
        // custom domains only get verifiedAt after the DNS check passes.
        verifiedAt: new Date(),
      })
      .onConflictDoNothing();
  }

  return tenant.id;
}

// ───────────────────────────────────────────────────────────────
// Catalog fixtures
// ───────────────────────────────────────────────────────────────

type SeedVariant = {
  sku: string;
  options?: Record<string, string>;
  pricePaise: number;
  compareAtPaise?: number;
  weightGrams: number;
};

type SeedProduct = {
  slug: string;
  title: string;
  summary: string;
  description: string;
  categorySlug: string;
  collectionSlug?: string;
  taxRateBps?: number;
  /** Declared axes, in display order: { Size: ['S','M','L'] } */
  options?: Record<string, string[]>;
  variants: SeedVariant[];
};

type SeedCatalog = {
  categories: { slug: string; title: string }[];
  collections: { slug: string; title: string }[];
  products: SeedProduct[];
};

/** A general retailer. Registered for GST, so its products carry a rate. */
const ACME_CATALOG: SeedCatalog = {
  categories: [
    { slug: "apparel", title: "Apparel" },
    { slug: "home-living", title: "Home & Living" },
  ],
  collections: [{ slug: "new-arrivals", title: "New Arrivals" }],
  products: [
    {
      slug: "classic-cotton-shirt",
      title: "Classic Cotton Shirt",
      summary: "Breathable full-sleeve shirt in mid-weight cotton.",
      description:
        "<p>A everyday shirt cut from mid-weight combed cotton, finished with a soft collar and " +
        "mother-of-pearl buttons. Machine washable.</p>",
      categorySlug: "apparel",
      collectionSlug: "new-arrivals",
      taxRateBps: 500,
      options: { Size: ["S", "M", "L"] },
      variants: [
        { sku: "ACME-SHIRT-S", options: { Size: "S" }, pricePaise: 129900, weightGrams: 240 },
        { sku: "ACME-SHIRT-M", options: { Size: "M" }, pricePaise: 129900, weightGrams: 250 },
        { sku: "ACME-SHIRT-L", options: { Size: "L" }, pricePaise: 129900, weightGrams: 265 },
      ],
    },
    {
      slug: "merino-wool-scarf",
      title: "Merino Wool Scarf",
      summary: "Fine-gauge merino, woven in a single panel.",
      description: "<p>Lightweight merino scarf, 180 × 30 cm. Dry clean only.</p>",
      categorySlug: "apparel",
      taxRateBps: 500,
      variants: [
        {
          sku: "ACME-SCARF",
          pricePaise: 249900,
          compareAtPaise: 299900,
          weightGrams: 150,
        },
      ],
    },
    {
      slug: "stoneware-mug",
      title: "Stoneware Mug",
      summary: "Reactive-glaze mug, 350 ml. Dishwasher safe.",
      description: "<p>Hand-glazed stoneware, so no two are identical. 350 ml capacity.</p>",
      categorySlug: "home-living",
      collectionSlug: "new-arrivals",
      taxRateBps: 1200,
      variants: [{ sku: "ACME-MUG", pricePaise: 49900, weightGrams: 400 }],
    },
  ],
};

/** An industrial trader. Unregistered, so no tax rate is declared yet. */
const GLOBEX_CATALOG: SeedCatalog = {
  categories: [
    { slug: "hand-tools", title: "Hand Tools" },
    { slug: "safety-equipment", title: "Safety Equipment" },
  ],
  collections: [{ slug: "bestsellers", title: "Bestsellers" }],
  products: [
    {
      slug: "torque-wrench",
      title: "Torque Wrench",
      summary: "Click-type torque wrench, calibrated to ±4%.",
      description:
        "<p>Reversible click-type wrench with a knurled adjustment collar and a locking ring. " +
        "Supplied with a calibration certificate.</p>",
      categorySlug: "hand-tools",
      collectionSlug: "bestsellers",
      options: { Drive: ['1/2"', '3/8"'] },
      variants: [
        { sku: "GLX-TW-12", options: { Drive: '1/2"' }, pricePaise: 899900, weightGrams: 1800 },
        { sku: "GLX-TW-38", options: { Drive: '3/8"' }, pricePaise: 749900, weightGrams: 1500 },
      ],
    },
    {
      slug: "safety-helmet",
      title: "Safety Helmet",
      summary: "Vented shell with a six-point ratchet harness.",
      description: "<p>High-density polyethylene shell with an adjustable ratchet harness.</p>",
      categorySlug: "safety-equipment",
      collectionSlug: "bestsellers",
      variants: [{ sku: "GLX-HELM", pricePaise: 129900, weightGrams: 450 }],
    },
    {
      slug: "insulated-gloves",
      title: "Insulated Gloves",
      summary: "Dielectric gloves for low-voltage work.",
      description: "<p>Natural rubber gloves with a cotton flock lining. Inspect before every use.</p>",
      categorySlug: "safety-equipment",
      variants: [{ sku: "GLX-GLOV", pricePaise: 89900, weightGrams: 300 }],
    },
  ],
};

/**
 * Resolves a slug to the entity that already holds it, if any.
 *
 * Idempotency for the catalog hangs off url_slugs rather than off a
 * natural key on the entity, because a product genuinely has none —
 * two products may share a title. Re-running the seed must not
 * duplicate the catalog, and must not fail either: `pnpm db:seed` gets
 * run reflexively after any local database wobble.
 */
async function existingSlug(
  db: ReturnType<typeof drizzle>,
  tenantId: string,
  slug: string,
): Promise<string | null> {
  const [row] = await db
    .select({ entityId: schema.urlSlugs.entityId })
    .from(schema.urlSlugs)
    .where(and(eq(schema.urlSlugs.tenantId, tenantId), eq(schema.urlSlugs.slug, slug)))
    .limit(1);

  return row?.entityId ?? null;
}

async function seedCatalog(
  db: ReturnType<typeof drizzle>,
  tenantId: string,
  catalog: SeedCatalog,
): Promise<void> {
  const categoryIds = new Map<string, string>();
  const collectionIds = new Map<string, string>();

  for (const [i, spec] of catalog.categories.entries()) {
    let id = await existingSlug(db, tenantId, spec.slug);
    if (!id) {
      id = uuidv7();
      await db.insert(schema.categories).values({
        id,
        tenantId,
        title: spec.title,
        position: i,
      });
      await db.insert(schema.urlSlugs).values({
        tenantId,
        slug: spec.slug,
        entityType: "category",
        entityId: id,
      });
    }
    categoryIds.set(spec.slug, id);
  }

  for (const [i, spec] of catalog.collections.entries()) {
    let id = await existingSlug(db, tenantId, spec.slug);
    if (!id) {
      id = uuidv7();
      await db.insert(schema.collections).values({
        id,
        tenantId,
        title: spec.title,
        position: i,
      });
      await db.insert(schema.urlSlugs).values({
        tenantId,
        slug: spec.slug,
        entityType: "collection",
        entityId: id,
      });
    }
    collectionIds.set(spec.slug, id);
  }

  for (const spec of catalog.products) {
    if (await existingSlug(db, tenantId, spec.slug)) continue;

    const productId = uuidv7();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      title: spec.title,
      summary: spec.summary,
      description: spec.description,
      status: "active",
      taxRateBps: spec.taxRateBps ?? null,
      publishedAt: new Date(),
    });

    await db.insert(schema.urlSlugs).values({
      tenantId,
      slug: spec.slug,
      entityType: "product",
      entityId: productId,
    });

    for (const [axisIndex, [name, values]] of Object.entries(spec.options ?? {}).entries()) {
      const optionId = uuidv7();
      await db.insert(schema.productOptions).values({
        id: optionId,
        tenantId,
        productId,
        name,
        position: axisIndex,
      });
      await db.insert(schema.productOptionValues).values(
        values.map((value, i) => ({
          id: uuidv7(),
          tenantId,
          optionId,
          value,
          position: i,
        })),
      );
    }

    await db.insert(schema.productVariants).values(
      spec.variants.map((v, i) => ({
        id: uuidv7(),
        tenantId,
        productId,
        sku: v.sku,
        options: v.options ?? {},
        pricePaise: v.pricePaise,
        compareAtPaise: v.compareAtPaise ?? null,
        weightGrams: v.weightGrams,
        position: i,
      })),
    );

    const categoryId = categoryIds.get(spec.categorySlug);
    if (categoryId) {
      await db.insert(schema.productCategories).values({ tenantId, productId, categoryId });
    }

    const collectionId = spec.collectionSlug
      ? collectionIds.get(spec.collectionSlug)
      : undefined;
    if (collectionId) {
      await db.insert(schema.productCollections).values({ tenantId, productId, collectionId });
    }
  }
}

main().catch((err: unknown) => {
  console.error("\n✖ Seed failed:\n", err);
  process.exit(1);
});
