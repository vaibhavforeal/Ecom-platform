import { randomUUID } from "node:crypto";

import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installNextDataCache, runRouteHandler } from "./next-cache-harness";

/**
 * The purge endpoint, against a real Next data cache and real
 * PostgreSQL.
 *
 * WHAT THESE TESTS ARE FOR
 *
 * "The endpoint returned 200" is not the property. The property is that
 * the storefront stops serving the old value, and the two ways that
 * silently fails are a tag string that does not match what
 * `unstable_cache` stored the entry under, and a purge that reaches the
 * wrong tenant's entries. Neither shows up in a status code and neither
 * shows up in a spy on `revalidateTag`.
 *
 * So every purge here is checked the only way that means anything:
 *
 *   read → change the row underneath the cache → read again and assert
 *   it is STILL STALE → purge → read again and assert it is fresh.
 *
 * The stale assertion in the middle is what stops these tests being
 * vacuous. If the harness ever stopped caching — one missing constructor
 * option does exactly that — the middle assertion fails loudly instead
 * of every test passing for the wrong reason.
 *
 * The 300s TTL is never waited on. Each test finishes in milliseconds,
 * so a value that changes can only have changed because of a purge.
 *
 * TWO THINGS THE FIXTURES HAVE TO DO, BOTH FORCED BY NEXT
 *
 *  1. **A fresh tenant per test.** Next's tag manifest is a
 *     process-global Map keyed by tag, so tags have to be unique per
 *     test or one test's purge decides the next one's outcome. Fresh
 *     tenant → fresh tenant-prefixed tags → fresh cache keys.
 *
 *  2. **No purge before the one under test.** `STOREFRONT_INTERNAL_ORIGIN`
 *     is deliberately unset here, so building a fixture with
 *     `createProduct` does not fire a purge of its own. That is not
 *     tidiness — on the installed Next, the FIRST purge of a tag is the
 *     only one that has any effect. See the KNOWN DEFECT test at the
 *     bottom, which pins that behaviour, and the task report.
 */

const TEST_SECRET = "test-internal-secret-9f2b7c1a";

await installNextDataCache();

const { getCachedProduct, getCachedSlugResolution } = await import("../src/lib/catalog");
const { POST: revalidateRoute } = await import("../src/app/api/internal/revalidate/route");
const { createProduct } = await import("@platform/core/catalog/server");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let actorUserId: string;

/** A purge request as the console sends it, but built here by hand. */
function purgeRequest(tenantId: string, tags: unknown, secret: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-internal-secret"] = secret;

  return new Request("http://storefront.test/api/internal/revalidate", {
    method: "POST",
    headers,
    body: JSON.stringify({ tenantId, tags }),
  });
}

function purge(tenantId: string, tags: unknown, secret: string | null = TEST_SECRET) {
  return runRouteHandler(() => revalidateRoute(purgeRequest(tenantId, tags, secret)));
}

async function makeTenant(): Promise<string> {
  const slug = "sf-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"sf-" + randomUUID().slice(0, 8)}, 'Purge test plan')
    RETURNING id`;
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  return tenant!.id;
}

/** An active product, which is the only kind the storefront will serve. */
async function makeProduct(
  tenantId: string,
  title: string,
): Promise<{ productId: string; slug: string }> {
  const result = await createProduct(
    { tenantId, actorUserId },
    {
      title,
      slug: null,
      summary: null,
      description: "<p>Original copy.</p>",
      status: "active",
      productType: null,
      vendor: null,
      tags: [],
      hsnCode: null,
      taxRateBps: null,
      seo: {},
      axes: [],
      variants: [
        {
          sku: `PURGE-${randomUUID().slice(0, 8)}`,
          barcode: null,
          options: {},
          pricePaise: 129900,
          compareAtPaise: null,
          costPaise: null,
          weightGrams: 240,
          lowStockAt: null,
          imageMediaId: null,
          isActive: true,
        },
      ],
      categoryIds: [],
      collectionIds: [],
      media: [],
    },
  );

  return { productId: result.productId, slug: result.slug };
}

/**
 * Caches a product, then changes the row behind it, so a caller can
 * check whether a purge (or a refused purge) emptied anything.
 */
async function stalenessFixture(): Promise<{ tenantId: string; productId: string }> {
  const tenantId = await makeTenant();
  const { productId } = await makeProduct(tenantId, "Guarded Title");

  expect((await getCachedProduct(tenantId, productId))?.title).toBe("Guarded Title");
  await admin`UPDATE products SET title = 'Should Stay Hidden' WHERE id = ${productId}`;
  expect((await getCachedProduct(tenantId, productId))?.title).toBe("Guarded Title");

  return { tenantId, productId };
}

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
  // See note 2 in the header: fixtures must not fire a purge of their
  // own. `.env` sets this, so it is removed rather than left alone.
  delete process.env.STOREFRONT_INTERNAL_ORIGIN;

  actorUserId = randomUUID();
  const phone = "+9196" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`
    INSERT INTO users (id, phone_e164, name) VALUES (${actorUserId}, ${phone}, 'Purge test')`;
});

afterAll(async () => {
  await admin.end();
  await closeConnections();
});

describe("POST /api/internal/revalidate — the cache actually empties", () => {
  it("serves the stale product until the endpoint is called, then the new one", async () => {
    const { tenantId, productId } = await stalenessFixture();

    // The tag is written out in full rather than taken from
    // `catalogTags` — the failure mode this guards is the two sides
    // disagreeing about the string, and a test that asks the
    // implementation what the string is cannot see that.
    const response = await purge(tenantId, [`t:${tenantId}:catalog`]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ purged: 1 });

    expect((await getCachedProduct(tenantId, productId))?.title).toBe("Should Stay Hidden");
  });

  it("clears the old slug's answer and the new one together, which is the rename case", async () => {
    const tenantId = await makeTenant();
    const { productId } = await makeProduct(tenantId, "Classic Cotton Shirt");

    // A real page render does exactly these reads: resolve the slug,
    // then load the product.
    await expect(getCachedSlugResolution(tenantId, "classic-cotton-shirt")).resolves.toEqual({
      action: "render",
      entityType: "product",
      entityId: productId,
    });

    // The NEW url gets cached too, as a miss — one customer following a
    // link that has not gone live yet is enough to put this entry in.
    // It is the half of the rename bug that is easy to forget: without
    // it the renamed product 404s on its own new URL for the whole TTL.
    await expect(getCachedSlugResolution(tenantId, "classic-oxford-shirt")).resolves.toEqual({
      action: "notFound",
    });

    // Rename the product underneath the cache, exactly as
    // `setCanonicalSlug` does it: demote the old row, promote the new.
    await admin`UPDATE products SET title = 'Classic Oxford Shirt' WHERE id = ${productId}`;
    await admin`UPDATE url_slugs SET is_canonical = false WHERE entity_id = ${productId}`;
    await admin`
      INSERT INTO url_slugs (tenant_id, slug, entity_type, entity_id, is_canonical)
      VALUES (${tenantId}, 'classic-oxford-shirt', 'product', ${productId}, true)`;

    // Still the old answers — the cache has not noticed a thing.
    await expect(getCachedSlugResolution(tenantId, "classic-cotton-shirt")).resolves.toEqual({
      action: "render",
      entityType: "product",
      entityId: productId,
    });
    await expect(getCachedSlugResolution(tenantId, "classic-oxford-shirt")).resolves.toEqual({
      action: "notFound",
    });

    // The tags a product write sends, written out in full. `slugs` is
    // the one that matters here and it is tenant-wide, which is exactly
    // why one purge fixes BOTH urls.
    const response = await purge(tenantId, [
      `t:${tenantId}:catalog`,
      `t:${tenantId}:slugs`,
      `t:${tenantId}:categories`,
      `t:${tenantId}:product:${productId}`,
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ purged: 4 });

    // Well inside the 300s TTL — this test takes milliseconds — so
    // these can only have changed because of the purge.
    expect((await getCachedProduct(tenantId, productId))?.title).toBe("Classic Oxford Shirt");

    // The OLD url redirects instead of rendering. This is the half of
    // the bug that outlived a restart in the live check on 2026-08-12.
    await expect(getCachedSlugResolution(tenantId, "classic-cotton-shirt")).resolves.toEqual({
      action: "redirect",
      to: "classic-oxford-shirt",
      permanent: true,
    });

    // And the new url, whose cached 404 is gone.
    await expect(getCachedSlugResolution(tenantId, "classic-oxford-shirt")).resolves.toEqual({
      action: "render",
      entityType: "product",
      entityId: productId,
    });
  });
});

describe("POST /api/internal/revalidate — refusals leave the cache alone", () => {
  it("403s a request with no secret at all, and purges nothing", async () => {
    const { tenantId, productId } = await stalenessFixture();

    const response = await purge(tenantId, [`t:${tenantId}:catalog`], null);

    expect(response.status).toBe(403);
    expect((await getCachedProduct(tenantId, productId))?.title).toBe("Guarded Title");
  });

  it("403s a wrong secret, and purges nothing", async () => {
    const { tenantId, productId } = await stalenessFixture();

    const response = await purge(tenantId, [`t:${tenantId}:catalog`], "not-the-secret");

    expect(response.status).toBe(403);
    expect((await getCachedProduct(tenantId, productId))?.title).toBe("Guarded Title");
  });

  it("403s every caller when no secret is configured, rather than letting them all in", async () => {
    const { tenantId, productId } = await stalenessFixture();

    // The failure mode being guarded: `/api/internal/verify-domain`
    // SKIPS its check when the secret is unset. This endpoint must not.
    delete process.env.INTERNAL_API_SECRET;
    try {
      const withSecret = await purge(tenantId, [`t:${tenantId}:catalog`], TEST_SECRET);
      const without = await purge(tenantId, [`t:${tenantId}:catalog`], null);

      expect(withSecret.status).toBe(403);
      expect(without.status).toBe(403);
      expect((await getCachedProduct(tenantId, productId))?.title).toBe("Guarded Title");
    } finally {
      process.env.INTERNAL_API_SECRET = TEST_SECRET;
    }
  });

  it("400s a tag belonging to another tenant, and purges neither tenant", async () => {
    const mine = await stalenessFixture();
    const theirs = await stalenessFixture();

    // Authenticated for `mine`, but reaching for `theirs`. The valid tag
    // is in the same request, so this also pins that the request is
    // refused whole rather than partially honoured.
    const response = await purge(mine.tenantId, [
      `t:${mine.tenantId}:catalog`,
      `t:${theirs.tenantId}:catalog`,
    ]);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "tag_outside_tenant" } });

    expect((await getCachedProduct(theirs.tenantId, theirs.productId))?.title).toBe(
      "Guarded Title",
    );
    expect((await getCachedProduct(mine.tenantId, mine.productId))?.title).toBe("Guarded Title");
  });

  it("leaves another tenant's cache alone on a legitimate purge", async () => {
    const mine = await stalenessFixture();
    const theirs = await stalenessFixture();

    const response = await purge(mine.tenantId, [`t:${mine.tenantId}:catalog`]);
    expect(response.status).toBe(200);

    // Mine cleared…
    expect((await getCachedProduct(mine.tenantId, mine.productId))?.title).toBe(
      "Should Stay Hidden",
    );
    // …and the neighbour's untouched. Tenant-prefixed tags are the only
    // reason this holds; a shared tag would empty every store on the box
    // every time any merchant saved anything.
    expect((await getCachedProduct(theirs.tenantId, theirs.productId))?.title).toBe(
      "Guarded Title",
    );
  });

  it("400s a body that is not a purge request", async () => {
    const tenantId = await makeTenant();

    const cases: [string, unknown][] = [
      ["no tags", undefined],
      ["empty tags", []],
      ["a tag that is not a string", [42]],
      // 65 tags. The cap is 64, and it is written out here rather than
      // imported so that raising it in the route fails this test.
      ["too many tags", Array.from({ length: 65 }, () => `t:${tenantId}:x`)],
    ];

    for (const [label, tags] of cases) {
      const response = await purge(tenantId, tags);
      expect(response.status, label).toBe(400);
    }
  });
});

describe("KNOWN DEFECT — Next ignores every purge of a tag after the first", () => {
  /**
   * THIS TEST PINS A BUG, NOT A FEATURE. When it starts failing, Next
   * has been fixed and it should be deleted along with whatever
   * workaround was put in for it.
   *
   * `FileSystemCache.revalidateTag` in Next 15.3.0 through at least
   * 15.5.23 reads:
   *
   *     for (const tag of tags) {
   *       if (!tagsManifest.has(tag)) tagsManifest.set(tag, Date.now());
   *     }
   *
   * — so the manifest keeps the timestamp of the FIRST purge of a tag
   * and never moves it. Staleness is `revalidatedAt >= entry.lastModified`,
   * and an entry re-cached after that first purge always has a later
   * `lastModified`, so it is never stale again. Next 15.2.9 and earlier
   * set the timestamp unconditionally; Next 16 rewrote the manifest to
   * hold `{revalidated, expired}` objects and sets them unconditionally.
   *
   * The consequence for this platform is severe and is why Task 6 is not
   * finished: `catalogTags.all` is on every catalog write, so only the
   * FIRST catalog write per tenant per storefront process is purged.
   * Every later edit waits out the 300s TTL — which is most of the bug
   * the endpoint was built to fix.
   */
  it("purges on the first call and silently does nothing on the second", async () => {
    const tenantId = await makeTenant();
    const { productId } = await makeProduct(tenantId, "First Title");

    expect((await getCachedProduct(tenantId, productId))?.title).toBe("First Title");
    await admin`UPDATE products SET title = 'Second Title' WHERE id = ${productId}`;

    // First purge: works.
    expect((await purge(tenantId, [`t:${tenantId}:catalog`])).status).toBe(200);
    expect((await getCachedProduct(tenantId, productId))?.title).toBe("Second Title");

    // Next's manifest stores whole milliseconds, so the re-cached entry
    // has to land in a later millisecond than the purge for this to be
    // testing the guard rather than a clock tie.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await getCachedProduct(tenantId, productId))?.title).toBe("Second Title");
    await admin`UPDATE products SET title = 'Third Title' WHERE id = ${productId}`;

    // Second purge: answers 200, and does nothing at all.
    expect((await purge(tenantId, [`t:${tenantId}:catalog`])).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(
      (await getCachedProduct(tenantId, productId))?.title,
      "if this is 'Third Title', Next has been fixed — delete this test",
    ).toBe("Second Title");
  });
});
