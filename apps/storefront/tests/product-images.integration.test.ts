import { randomUUID } from "node:crypto";

import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * What a listing card actually sends to the browser.
 *
 * The unit under test is the whole path — the card projection in
 * `listProducts`, `srcSetFor`, and the `<img>` — because every way this
 * breaks is silent. A projection that loses `derivatives` renders a
 * card that still looks right and downloads a 1600px original into a
 * 300px slot; a `srcset` of "" makes some browsers fetch nothing at
 * all. Neither shows up anywhere but in the emitted markup, so the
 * assertions below are on the markup.
 *
 * The base URL is fixed here so the expected URLs can be written out in
 * full rather than rebuilt from the same helper the code under test
 * uses. `mediaUrl` reads the variable per call, so setting it before
 * the import is not required — but it is set first anyway, because
 * relying on that is a footgun.
 */
process.env.MEDIA_PUBLIC_BASE_URL = "https://cdn.example.test/media";

const { listProducts } = await import("@platform/core/catalog/server");
const { ProductCardTile } = await import("../src/components/ProductGrid");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

/**
 * The ladder as the worker writes it: three formats, and NOT in
 * ascending width order. A `srcset` builder that forwards the array as
 * it found it, or that forgets to filter by format, produces candidates
 * the browser picks from wrongly — and still renders a picture, so only
 * an exact-string assertion catches it.
 *
 * Bound `::text::jsonb`, never `::jsonb`: postgres.js sees the
 * server-inferred `jsonb` parameter type and JSON-encodes the string it
 * was given, storing a jsonb *string* that spells an array. It reads
 * back through Drizzle looking fine and arrives here as a string.
 */
const HERO_DERIVATIVES = [
  { format: "webp", width: 640, height: 427, storageKey: "s/d/hero/640.webp", byteSize: 40100 },
  { format: "avif", width: 320, height: 214, storageKey: "s/d/hero/320.avif", byteSize: 8800 },
  { format: "webp", width: 320, height: 214, storageKey: "s/d/hero/320.webp", byteSize: 12300 },
];

let tenantId: string;

async function card(title: string) {
  const { items } = await listProducts(tenantId);
  const found = items.find((i) => i.title === title);
  if (!found) throw new Error(`fixture product "${title}" is not in the listing`);
  return found;
}

function render(product: Parameters<typeof ProductCardTile>[0]["product"]): string {
  return renderToStaticMarkup(createElement(ProductCardTile, { product, priority: true }));
}

beforeAll(async () => {
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"s-" + randomUUID().slice(0, 8)}, 'Storefront image plan')
    RETURNING id`;
  const slug = "s-" + randomUUID().slice(0, 12);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  tenantId = tenant!.id;

  const product = async (title: string, urlSlug: string, sku: string) => {
    const id = randomUUID();
    await admin`
      INSERT INTO products (id, tenant_id, title, status, published_at)
      VALUES (${id}, ${tenantId}, ${title}, 'active', now())`;
    await admin`
      INSERT INTO url_slugs (tenant_id, slug, entity_type, entity_id)
      VALUES (${tenantId}, ${urlSlug}, 'product', ${id})`;
    await admin`
      INSERT INTO product_variants (id, tenant_id, product_id, sku, price_paise, weight_grams)
      VALUES (${randomUUID()}, ${tenantId}, ${id}, ${sku}, 129900, 300)`;
    return id;
  };

  const attach = async (productId: string, mediaId: string) =>
    admin`
      INSERT INTO product_media (tenant_id, product_id, media_id, position)
      VALUES (${tenantId}, ${productId}, ${mediaId}, 0)`;

  const derived = await product("Derived Shirt", `${slug}-derived`, `${slug}-D`);
  const derivedMedia = randomUUID();
  await admin`
    INSERT INTO media (id, tenant_id, storage_key, mime_type, byte_size, width, height,
                       alt, status, derivatives)
    VALUES (${derivedMedia}, ${tenantId}, 's/originals/hero.jpg', 'image/jpeg', 210000,
            1600, 1068, 'Shirt on a hanger', 'ready',
            ${JSON.stringify(HERO_DERIVATIVES)}::text::jsonb)`;
  await attach(derived, derivedMedia);

  // Ready, but nothing was ever derived from it — the state a row is in
  // when it was written by a backfill or a restored dump, and the state
  // every row is in for as long as the worker is behind.
  const plain = await product("Underived Shirt", `${slug}-plain`, `${slug}-P`);
  const plainMedia = randomUUID();
  await admin`
    INSERT INTO media (id, tenant_id, storage_key, mime_type, byte_size, width, height, status)
    VALUES (${plainMedia}, ${tenantId}, 's/originals/plain.jpg', 'image/jpeg', 90000,
            900, 600, 'ready')`;
  await attach(plain, plainMedia);

  // Still queued, and one the worker gave up on.
  const unprocessed = await product("Unprocessed Shirt", `${slug}-queued`, `${slug}-Q`);
  const pendingMedia = randomUUID();
  const failedMedia = randomUUID();
  await admin`
    INSERT INTO media (id, tenant_id, storage_key, mime_type, byte_size, status) VALUES
      (${pendingMedia}, ${tenantId}, 's/originals/queued.jpg', 'image/jpeg', 70000, 'pending'),
      (${failedMedia},  ${tenantId}, 's/originals/broken.jpg', 'image/jpeg', 70000, 'failed')`;
  await attach(unprocessed, pendingMedia);
  await admin`
    INSERT INTO product_media (tenant_id, product_id, media_id, position)
    VALUES (${tenantId}, ${unprocessed}, ${failedMedia}, 1)`;
});

afterAll(async () => {
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`;
  await admin.end({ timeout: 5 });
  await closeConnections();
});

describe("ProductCardTile", () => {
  it("emits a srcset of the WebP ladder, smallest first", async () => {
    const markup = render(await card("Derived Shirt"));

    // Written out in full: ascending by width, AVIF excluded, and each
    // candidate carrying its own `w` descriptor. Rebuilding this from
    // IMAGE_WIDTHS or from srcSetFor would make it pass by definition.
    expect(markup).toContain(
      'srcSet="https://cdn.example.test/media/s/d/hero/320.webp 320w,' +
        ' https://cdn.example.test/media/s/d/hero/640.webp 640w"',
    );
    expect(markup).not.toContain("320.avif");
  });

  it("keeps the original as src so a client that ignores srcset still loads", async () => {
    const markup = render(await card("Derived Shirt"));
    expect(markup).toContain('src="https://cdn.example.test/media/s/originals/hero.jpg"');
  });

  it("hints the layout with the card sizes, not the hero's", async () => {
    // Wrong `sizes` is worse than none: the browser picks its candidate
    // from `srcset` BEFORE layout using this string alone, so a hero
    // hint on a card pulls the 640 into a 300px slot.
    const markup = render(await card("Derived Shirt"));
    expect(markup).toContain(
      'sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 300px"',
    );
    expect(markup).not.toContain("100vw");
  });

  it("emits the intrinsic width and height to hold the layout", async () => {
    const markup = render(await card("Derived Shirt"));
    expect(markup).toContain('width="1600"');
    expect(markup).toContain('height="1068"');
  });

  it("omits srcset entirely when there are no derivatives", async () => {
    // NOT srcset="". An empty attribute makes some browsers fetch
    // nothing at all, which is a blank card rather than a slow one — so
    // the assertion is that the attribute is absent, and that the
    // original is still there to render.
    const markup = render(await card("Underived Shirt"));

    expect(markup).not.toContain("srcSet");
    expect(markup).not.toContain("srcset");
    expect(markup).toContain('src="https://cdn.example.test/media/s/originals/plain.jpg"');
    expect(markup).toContain('width="900"');
    expect(markup).toContain('height="600"');
  });

  it("renders a placeholder, not a broken image, while media is pending or failed", async () => {
    // Unprocessed media is not published at all, so the card has no
    // storage key to link. What it must not do is emit an <img> with an
    // empty or missing src.
    const product = await card("Unprocessed Shirt");
    expect(product.imageStorageKey).toBeNull();

    const markup = render(product);
    expect(markup).not.toContain("<img");
    expect(markup).toContain('class="card-media-empty"');
  });
});
