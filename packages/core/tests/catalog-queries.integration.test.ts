import { randomUUID } from "node:crypto";

import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getProductById,
  listCategories,
  listProducts,
  listSitemapEntries,
  resolveStorefrontSlug,
} from "../src/catalog/queries";

/**
 * The catalog query layer, against a real database.
 *
 * These queries are mostly SQL — correlated subqueries for the default
 * variant price, an EXISTS for category filtering, a three-way UNION for
 * the sitemap. TypeScript checks none of it. Everything below is here
 * because it can only fail at runtime.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantA: string;
let tenantB: string;
let tenantC: string;
let shirtId: string;
let categoryId: string;
let planId: string;

const SHIRT_SLUG = "q-cotton-shirt";
const SHIRT_OLD_SLUG = "q-cotton-shirt-old";
const CATEGORY_SLUG = "q-apparel";

/**
 * The shirt's derivative set, exactly as the worker would have written
 * it — and deliberately NOT in the order a `srcset` needs.
 *
 * Three formats interleaved, and the 640px WebP stored before the 320px
 * one, so a projection that loses the array, reorders it or drops a
 * format cannot pass by accident. The storefront is what sorts and
 * filters; this is the raw jsonb.
 */
const SHIRT_DERIVATIVES = [
  { format: "webp", width: 640, height: 427, storageKey: "q/d/shirtsum/640.webp", byteSize: 40100 },
  { format: "avif", width: 320, height: 214, storageKey: "q/d/shirtsum/320.avif", byteSize: 8800 },
  { format: "webp", width: 320, height: 214, storageKey: "q/d/shirtsum/320.webp", byteSize: 12300 },
];

/**
 * Every jsonb fixture below is bound `::text::jsonb`, never `::jsonb`.
 *
 * With a bare `::jsonb`, postgres.js takes the parameter type the
 * server infers (`ParameterDescription` backfills OID 3802 into the
 * statement), and its serializer for that OID is `JSON.stringify` — so
 * it JSON-ENCODES the string it was handed and the column ends up
 * holding a jsonb *string* that spells an array rather than the array.
 *
 * Drizzle is not saved from this by sending text: `PgJsonb`'s
 * `mapToDriverValue` hands over exactly the same `JSON.stringify(...)`
 * string a fixture does. What saves it is that `drizzle(client)`
 * MUTATES the client, replacing `options.serializers["114"]` and
 * `["3802"]` with an identity function. So the deciding factor is which
 * client object you hold, not the encoding: this file holds a bare
 * `postgres()` client, which still has the encoding serializers.
 *
 * Reading one back through Drizzle hides the damage — its jsonb decoder
 * parses a string value — but `jsonb_build_object` nests it as a string
 * and `parseDerivatives` then finds no derivatives at all. Casting
 * through `text` makes the inferred type `text` and lets Postgres parse.
 */

beforeAll(async () => {
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"q-" + randomUUID().slice(0, 8)}, 'Query test plan')
    RETURNING id`;
  planId = plan!.id;

  const mkTenant = async (slug: string) => {
    const [t] = await admin<{ id: string }[]>`
      INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
      VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
      RETURNING id`;
    return t!.id;
  };

  tenantA = await mkTenant("q-a-" + randomUUID().slice(0, 8));
  tenantB = await mkTenant("q-b-" + randomUUID().slice(0, 8));
  // Its own tenant so the counts the listing tests assert on above do
  // not have to know about these two.
  tenantC = await mkTenant("q-c-" + randomUUID().slice(0, 8));

  // ── Tenant A: one full product, one draft, one archived ──
  categoryId = randomUUID();
  await admin`
    INSERT INTO categories (id, tenant_id, title, position)
    VALUES (${categoryId}, ${tenantA}, 'Apparel', 0)`;
  await admin`
    INSERT INTO url_slugs (tenant_id, slug, entity_type, entity_id)
    VALUES (${tenantA}, ${CATEGORY_SLUG}, 'category', ${categoryId})`;

  shirtId = randomUUID();
  await admin`
    INSERT INTO products (id, tenant_id, title, summary, description, status, published_at)
    VALUES (${shirtId}, ${tenantA}, 'Cotton Shirt', 'A breathable shirt.',
            'Long form copy about the shirt.', 'active', now())`;

  // Canonical slug plus a historical one, to exercise the redirect path.
  await admin`
    INSERT INTO url_slugs (tenant_id, slug, entity_type, entity_id, is_canonical) VALUES
      (${tenantA}, ${SHIRT_SLUG},     'product', ${shirtId}, true),
      (${tenantA}, ${SHIRT_OLD_SLUG}, 'product', ${shirtId}, false)`;

  await admin`
    INSERT INTO product_categories (tenant_id, product_id, category_id)
    VALUES (${tenantA}, ${shirtId}, ${categoryId})`;

  const optionId = randomUUID();
  await admin`
    INSERT INTO product_options (id, tenant_id, product_id, name, position)
    VALUES (${optionId}, ${tenantA}, ${shirtId}, 'Size', 0)`;
  await admin`
    INSERT INTO product_option_values (id, tenant_id, option_id, value, position) VALUES
      (${randomUUID()}, ${tenantA}, ${optionId}, 'S', 0),
      (${randomUUID()}, ${tenantA}, ${optionId}, 'M', 1)`;

  // The cheaper variant is deliberately SECOND by position, so a query
  // that takes "first by position" instead of "cheapest" fails.
  await admin`
    INSERT INTO product_variants
      (id, tenant_id, product_id, sku, options, price_paise, compare_at_paise,
       weight_grams, position, is_active)
    VALUES
      (${randomUUID()}, ${tenantA}, ${shirtId}, 'Q-SHIRT-M',
       ${'{"Size":"M"}'}::jsonb, 149900, 199900, 250, 0, true),
      (${randomUUID()}, ${tenantA}, ${shirtId}, 'Q-SHIRT-S',
       ${'{"Size":"S"}'}::jsonb,  99900, 149900, 240, 1, true)`;

  const draftId = randomUUID();
  await admin`
    INSERT INTO products (id, tenant_id, title, status)
    VALUES (${draftId}, ${tenantA}, 'Unfinished Draft', 'draft')`;
  await admin`
    INSERT INTO url_slugs (tenant_id, slug, entity_type, entity_id)
    VALUES (${tenantA}, 'q-draft', 'product', ${draftId})`;

  const archivedId = randomUUID();
  await admin`
    INSERT INTO products (id, tenant_id, title, status)
    VALUES (${archivedId}, ${tenantA}, 'Archived Thing', 'archived')`;
  await admin`
    INSERT INTO url_slugs (tenant_id, slug, entity_type, entity_id)
    VALUES (${tenantA}, 'q-archived', 'product', ${archivedId})`;

  // Two gallery images, the second one first by insertion order, so
  // "position 0" has to be honoured rather than "whatever came back".
  const heroMediaId = randomUUID();
  const secondMediaId = randomUUID();
  await admin`
    INSERT INTO media (id, tenant_id, storage_key, mime_type, byte_size, width, height,
                       alt, status, derivatives)
    VALUES
      (${secondMediaId}, ${tenantA}, 'q/originals/second.jpg', 'image/jpeg', 90000, 800, 800,
       'Folded', 'ready', ${JSON.stringify([
         { format: "webp", width: 480, height: 480, storageKey: "q/d/second/480.webp", byteSize: 1 },
       ])}::text::jsonb),
      (${heroMediaId}, ${tenantA}, 'q/originals/shirtsum.jpg', 'image/jpeg', 210000, 1600, 1068,
       'Shirt on a hanger', 'ready', ${JSON.stringify(SHIRT_DERIVATIVES)}::text::jsonb)`;
  await admin`
    INSERT INTO product_media (tenant_id, product_id, media_id, position) VALUES
      (${tenantA}, ${shirtId}, ${secondMediaId}, 1),
      (${tenantA}, ${shirtId}, ${heroMediaId},   0)`;

  // ── Tenant B: its own product, at a slug tenant A also uses ──
  const bProductId = randomUUID();
  await admin`
    INSERT INTO products (id, tenant_id, title, status, published_at)
    VALUES (${bProductId}, ${tenantB}, 'Torque Wrench', 'active', now())`;
  await admin`
    INSERT INTO url_slugs (tenant_id, slug, entity_type, entity_id)
    VALUES (${tenantB}, ${SHIRT_SLUG}, 'product', ${bProductId})`;
  await admin`
    INSERT INTO product_variants
      (id, tenant_id, product_id, sku, price_paise, weight_grams)
    VALUES (${randomUUID()}, ${tenantB}, ${bProductId}, 'Q-WRENCH', 899900, 1800)`;

  // ── Tenant C: the two images that have no derivatives to serve ──
  const mkProduct = async (title: string, slug: string, sku: string) => {
    const id = randomUUID();
    await admin`
      INSERT INTO products (id, tenant_id, title, status, published_at)
      VALUES (${id}, ${tenantC}, ${title}, 'active', now())`;
    await admin`
      INSERT INTO url_slugs (tenant_id, slug, entity_type, entity_id)
      VALUES (${tenantC}, ${slug}, 'product', ${id})`;
    await admin`
      INSERT INTO product_variants (id, tenant_id, product_id, sku, price_paise, weight_grams)
      VALUES (${randomUUID()}, ${tenantC}, ${id}, ${sku}, 50000, 100)`;
    return id;
  };

  // `ready`, but the derivatives column is still the column default —
  // a row written by a backfill, a restored dump or psql. The card has
  // an original to show and nothing to build a srcset from.
  const underivedId = await mkProduct("Underived Photo", "q-underived", "Q-UNDERIVED");
  const underivedMediaId = randomUUID();
  await admin`
    INSERT INTO media (id, tenant_id, storage_key, mime_type, byte_size, width, height, status)
    VALUES (${underivedMediaId}, ${tenantC}, 'q/originals/plain.jpg', 'image/jpeg', 60000,
            900, 600, 'ready')`;
  await admin`
    INSERT INTO product_media (tenant_id, product_id, media_id, position)
    VALUES (${tenantC}, ${underivedId}, ${underivedMediaId}, 0)`;

  // Still queued behind the worker, and one that will never finish.
  const unprocessedId = await mkProduct("Unprocessed Photo", "q-unprocessed", "Q-UNPROCESSED");
  const pendingMediaId = randomUUID();
  const failedMediaId = randomUUID();
  await admin`
    INSERT INTO media (id, tenant_id, storage_key, mime_type, byte_size, status) VALUES
      (${pendingMediaId}, ${tenantC}, 'q/originals/queued.jpg', 'image/jpeg', 70000, 'pending'),
      (${failedMediaId},  ${tenantC}, 'q/originals/broken.jpg', 'image/jpeg', 70000, 'failed')`;
  await admin`
    INSERT INTO product_media (tenant_id, product_id, media_id, position) VALUES
      (${tenantC}, ${unprocessedId}, ${pendingMediaId}, 0),
      (${tenantC}, ${unprocessedId}, ${failedMediaId},  1)`;
});

afterAll(async () => {
  await admin`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB}, ${tenantC})`;
  await admin`DELETE FROM plans WHERE id = ${planId}`;
  await admin.end({ timeout: 5 });
  await closeConnections();
});

describe("resolveStorefrontSlug", () => {
  it("renders a canonical slug", async () => {
    expect(await resolveStorefrontSlug(tenantA, SHIRT_SLUG)).toEqual({
      action: "render",
      entityType: "product",
      entityId: shirtId,
    });
  });

  it("permanently redirects a historical slug to the canonical one", async () => {
    expect(await resolveStorefrontSlug(tenantA, SHIRT_OLD_SLUG)).toEqual({
      action: "redirect",
      to: SHIRT_SLUG,
      permanent: true,
    });
  });

  it("404s an unknown slug", async () => {
    expect(await resolveStorefrontSlug(tenantA, "no-such-thing")).toEqual({ action: "notFound" });
  });

  it("resolves the same slug to a different product per tenant", async () => {
    const a = await resolveStorefrontSlug(tenantA, SHIRT_SLUG);
    const b = await resolveStorefrontSlug(tenantB, SHIRT_SLUG);
    expect(a).not.toEqual(b);
  });
});

describe("listProducts", () => {
  it("returns only this tenant's published products", async () => {
    const { items, total } = await listProducts(tenantA);
    expect(total).toBe(1);
    expect(items.map((i) => i.title)).toEqual(["Cotton Shirt"]);
  });

  it("hides drafts and archived products", async () => {
    // A listing that forgets this puts a merchant's placeholder titles
    // and test prices on a live storefront.
    const { items } = await listProducts(tenantA);
    const titles = items.map((i) => i.title);
    expect(titles).not.toContain("Unfinished Draft");
    expect(titles).not.toContain("Archived Thing");
  });

  it("prices the card from the CHEAPEST active variant, not the first", async () => {
    // The listing and the PDP headline have to agree, or the card reads
    // as a bait-and-switch. The cheap variant is second by position.
    const { items } = await listProducts(tenantA);
    expect(items[0]?.pricePaise).toBe(99900);
    expect(items[0]?.compareAtPaise).toBe(149900);
    expect(items[0]?.currency).toBe("INR");
  });

  it("attaches the canonical slug", async () => {
    const { items } = await listProducts(tenantA);
    expect(items[0]?.slug).toBe(SHIRT_SLUG);
  });

  it("filters by category", async () => {
    expect((await listProducts(tenantA, { categoryIds: [categoryId] })).total).toBe(1);
    expect((await listProducts(tenantA, { categoryIds: [randomUUID()] })).total).toBe(0);
  });

  it("searches full text with stemming", async () => {
    // 'shirts' must find 'Shirt' — that is the whole reason the column
    // is built with the 'english' configuration rather than 'simple'.
    expect((await listProducts(tenantA, { search: "shirts" })).total).toBe(1);
    expect((await listProducts(tenantA, { search: "breathable" })).total).toBe(1);
    expect((await listProducts(tenantA, { search: "wrench" })).total).toBe(0);
  });

  it("survives search input that would break to_tsquery", async () => {
    // to_tsquery raises a syntax error on these; websearch_to_tsquery
    // does not. This test is the difference between a search page and a
    // 500 page.
    for (const nasty of ["shirts & ties", "shirt | ", "!!!", '"unclosed', "a:*:*"]) {
      await expect(listProducts(tenantA, { search: nasty })).resolves.toBeDefined();
    }
  });

  it("never returns another tenant's products", async () => {
    const { items } = await listProducts(tenantA, { search: "wrench" });
    expect(items).toEqual([]);
    expect((await listProducts(tenantB)).items.map((i) => i.title)).toEqual(["Torque Wrench"]);
  });

  it("paginates", async () => {
    const page = await listProducts(tenantA, { limit: 1, offset: 5 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(1); // total is of the whole result set
  });

  it("projects the position-0 image with its derivatives", async () => {
    // The card is the whole point of the derivative ladder: without
    // this column every listing downloads the full-size original at
    // every breakpoint. And the two ways this SQL fails are silent —
    // an interpolated correlated reference or a missing `.as()` alias
    // both come back NULL with no error — so the assertion is on the
    // VALUE, never on "it is defined".
    const { items } = await listProducts(tenantA);
    const card = items[0];

    expect(card?.imageStorageKey).toBe("q/originals/shirtsum.jpg");
    expect(card?.imageAlt).toBe("Shirt on a hanger");
    expect(card?.imageWidth).toBe(1600);
    expect(card?.imageHeight).toBe(1068);
    // Order preserved, every format carried, nothing invented.
    expect(card?.imageDerivatives).toEqual(SHIRT_DERIVATIVES);
  });

  it("carries an empty derivative set rather than the other image's", async () => {
    // `ready` with the column at its default. The card still has an
    // original to render; there is simply no srcset to build.
    const { items } = await listProducts(tenantC);
    const card = items.find((i) => i.title === "Underived Photo");

    expect(card?.imageStorageKey).toBe("q/originals/plain.jpg");
    expect(card?.imageWidth).toBe(900);
    expect(card?.imageHeight).toBe(600);
    expect(card?.imageDerivatives).toEqual([]);
  });

  it("shows no image for a product whose media is still pending or failed", async () => {
    // Unprocessed media is not published: the card falls back to the
    // empty placeholder rather than linking bytes the pipeline has not
    // finished with. Pinned because it is the other half of the
    // "no derivatives" story — see ProductGrid.
    const { items } = await listProducts(tenantC);
    const card = items.find((i) => i.title === "Unprocessed Photo");

    expect(card).toBeDefined();
    expect(card?.imageStorageKey).toBeNull();
    expect(card?.imageDerivatives).toBeNull();
  });
});

describe("getProductById", () => {
  it("assembles axes, variants and slug", async () => {
    const product = await getProductById(tenantA, shirtId);
    expect(product).not.toBeNull();
    expect(product?.slug).toBe(SHIRT_SLUG);
    expect(product?.axes).toEqual([{ name: "Size", values: ["S", "M"] }]);
    expect(product?.variants.map((v) => v.sku).sort()).toEqual(["Q-SHIRT-M", "Q-SHIRT-S"]);
    expect(product?.categoryIds).toEqual([categoryId]);
  });

  it("decodes the option map", async () => {
    const product = await getProductById(tenantA, shirtId);
    const small = product?.variants.find((v) => v.sku === "Q-SHIRT-S");
    expect(small?.options).toEqual({ Size: "S" });
  });

  it("returns null for another tenant's product id", async () => {
    expect(await getProductById(tenantB, shirtId)).toBeNull();
  });

  it("returns null for an unpublished product", async () => {
    const [draft] = await admin<{ id: string }[]>`
      SELECT id FROM products WHERE tenant_id = ${tenantA} AND status = 'draft' LIMIT 1`;
    expect(await getProductById(tenantA, draft!.id)).toBeNull();
  });
});

describe("listCategories", () => {
  it("returns visible categories with slugs", async () => {
    const cats = await listCategories(tenantA);
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({ id: categoryId, title: "Apparel", slug: CATEGORY_SLUG });
  });

  it("is empty for a tenant with no categories", async () => {
    expect(await listCategories(tenantB)).toEqual([]);
  });
});

describe("listSitemapEntries", () => {
  it("lists canonical URLs only", async () => {
    const entries = await listSitemapEntries(tenantA);
    const slugs = entries.map((e) => e.slug);

    expect(slugs).toContain(SHIRT_SLUG);
    expect(slugs).toContain(CATEGORY_SLUG);

    // A historical slug redirects. Listing it in a sitemap tells Google to
    // index a URL that redirects, which is a crawl-budget own goal.
    expect(slugs).not.toContain(SHIRT_OLD_SLUG);
    // Drafts and archived products are not public.
    expect(slugs).not.toContain("q-draft");
    expect(slugs).not.toContain("q-archived");
  });

  it("carries a last-modified date per URL", async () => {
    const entries = await listSitemapEntries(tenantA);
    expect(entries[0]?.updatedAt).toBeInstanceOf(Date);
  });

  it("does not cross tenants", async () => {
    const entries = await listSitemapEntries(tenantB);
    expect(entries.map((e) => e.slug)).toEqual([SHIRT_SLUG]);
  });
});
