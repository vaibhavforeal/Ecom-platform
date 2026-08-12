import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import postgres from "postgres";
import type { Notice, TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeConnections } from "../src/index";

/**
 * The de-duplication step of migration 0004, run for real.
 *
 * That step executes ONCE, against production data, in a maintenance
 * window, and by then it is far too late to find out which shapes of
 * duplicate it did not consider. So the migration file is read off disk
 * and applied verbatim here, to a fixture built specifically to contain
 * the shapes that are awkward.
 *
 * The recipe, inside one transaction that is always rolled back:
 *
 *   rewind the index to non-unique  (so duplicates can be inserted at
 *                                    all — that is what 0004 forbids)
 *   build the fixture
 *   run every statement of 0004 in order
 *   record what it did
 *   throw, so nothing survives
 *
 * The rewind is what makes this a test of the migration rather than of
 * the schema: it puts the database back in the state 0004 expects to
 * find and lets 0004 do its own DROP INDEX / CREATE UNIQUE INDEX.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

/**
 * Named, not globbed. This tests THIS migration; if the file is ever
 * renamed, the failure should say so rather than quietly testing
 * whichever file sorted last.
 */
const MIGRATION_PATH = resolve(import.meta.dirname, "../drizzle/0004_lovely_jack_flag.sql");

/** Collected so the "report what you deleted" requirement can be asserted. */
const notices: Notice[] = [];

const admin = postgres(migratorUrl, {
  max: 1,
  onnotice: (notice) => notices.push(notice),
});

type Label =
  | "A_keep"
  | "A_pending"
  | "A_deleted"
  | "B_keep"
  | "B_loser"
  | "no_checksum_1"
  | "no_checksum_2";

type Fixture = {
  tenantId: string;
  products: Record<"withKeeperAndLoser" | "withLoserOnly" | "withTwoLosers", string>;
  categoryId: string;
  collectionId: string;
  variantId: string;
  media: Record<Label, string>;
  /** id → label, so failures name the row rather than a UUID. */
  labelOf: Map<string, Label>;
};

type Outcome = {
  survivingMedia: Label[];
  galleries: Record<string, { media: Label; position: number }[]>;
  categoryImage: Label | null;
  collectionImage: Label | null;
  variantImage: Label | null;
  indexDef: string;
  warnings: string[];
};

/**
 * Two checksums' worth of duplicates, arranged so that every way a
 * product can hold them is present:
 *
 *   product 1 — the keeper AND one of its losers
 *   product 2 — one loser, and nothing else
 *   product 3 — TWO losers of one checksum plus a loser of another,
 *               with both keepers attached elsewhere
 *
 * The third is the one that matters. Repointing each loser to its
 * keeper collides on product_media's primary key, and it is the
 * natural shape for this data: one photo uploaded three times before
 * dedupe existed, two of the copies dropped into one gallery.
 */
async function seed(tx: TransactionSql): Promise<Fixture> {
  const [plan] = await tx<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"dup-" + randomUUID().slice(0, 8)}, 'Dedupe migration plan')
    RETURNING id`;

  const slug = "dup-" + randomUUID().slice(0, 12);
  const [tenant] = await tx<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  const tenantId = tenant!.id;

  const products = {
    withKeeperAndLoser: randomUUID(),
    withLoserOnly: randomUUID(),
    withTwoLosers: randomUUID(),
  };
  for (const [title, id] of Object.entries(products)) {
    await tx`
      INSERT INTO products (id, tenant_id, title, status)
      VALUES (${id}, ${tenantId}, ${title}, 'active')`;
  }

  const categoryId = randomUUID();
  await tx`INSERT INTO categories (id, tenant_id, title) VALUES (${categoryId}, ${tenantId}, 'C')`;
  const collectionId = randomUUID();
  await tx`INSERT INTO collections (id, tenant_id, title) VALUES (${collectionId}, ${tenantId}, 'L')`;
  const variantId = randomUUID();
  await tx`
    INSERT INTO product_variants (id, tenant_id, product_id, sku, price_paise, weight_grams)
    VALUES (${variantId}, ${tenantId}, ${products.withLoserOnly}, ${slug + "-SKU"}, 1000, 10)`;

  const media = {
    A_keep: randomUUID(),
    A_pending: randomUUID(),
    A_deleted: randomUUID(),
    B_keep: randomUUID(),
    B_loser: randomUUID(),
    no_checksum_1: randomUUID(),
    no_checksum_2: randomUUID(),
  } satisfies Record<Label, string>;

  /**
   * Distinct storage keys, because the (tenant_id, storage_key) index
   * is untouched by this migration and would otherwise be what rejects
   * the fixture. Real duplicates look exactly like this: same bytes
   * stored under different extensions.
   *
   * A_keep must win its group on every tiebreak the migration applies —
   * `ready` beats `pending`, live beats soft-deleted — and it is
   * deliberately NOT the oldest, so a rule of "keep the oldest" fails
   * here rather than passing by luck.
   */
  const insert = (
    id: string,
    key: string,
    checksum: string | null,
    status: string,
    deleted: boolean,
    ageDays: number,
  ) => tx`
    INSERT INTO media (id, tenant_id, storage_key, mime_type, byte_size, checksum, status,
                       deleted_at, created_at)
    VALUES (${id}, ${tenantId}, ${key}, 'image/jpeg', 1000, ${checksum}, ${status},
            ${deleted ? new Date() : null}, now() - make_interval(days => ${ageDays}))`;

  await insert(media.A_deleted, "d/originals/a.webp", "CHK-A", "ready", true, 3);
  await insert(media.A_pending, "d/originals/a.png", "CHK-A", "pending", false, 2);
  await insert(media.A_keep, "d/originals/a.jpg", "CHK-A", "ready", false, 1);
  await insert(media.B_loser, "d/originals/b.png", "CHK-B", "pending", false, 2);
  await insert(media.B_keep, "d/originals/b.jpg", "CHK-B", "ready", false, 1);
  await insert(media.no_checksum_1, "d/originals/n1.jpg", null, "pending", false, 1);
  await insert(media.no_checksum_2, "d/originals/n2.jpg", null, "pending", false, 1);

  const attach = (productId: string, mediaId: string, position: number) => tx`
    INSERT INTO product_media (tenant_id, product_id, media_id, position)
    VALUES (${tenantId}, ${productId}, ${mediaId}, ${position})`;

  await attach(products.withKeeperAndLoser, media.A_keep, 0);
  await attach(products.withKeeperAndLoser, media.A_pending, 1);

  await attach(products.withLoserOnly, media.A_deleted, 0);

  await attach(products.withTwoLosers, media.A_pending, 0);
  await attach(products.withTwoLosers, media.A_deleted, 1);
  await attach(products.withTwoLosers, media.B_loser, 2);

  await tx`UPDATE categories SET image_media_id = ${media.A_pending} WHERE id = ${categoryId}`;
  await tx`UPDATE collections SET image_media_id = ${media.A_deleted} WHERE id = ${collectionId}`;
  await tx`UPDATE product_variants SET image_media_id = ${media.B_loser} WHERE id = ${variantId}`;

  return {
    tenantId,
    products,
    categoryId,
    collectionId,
    variantId,
    media,
    labelOf: new Map(Object.entries(media).map(([label, id]) => [id, label as Label])),
  };
}

async function observe(tx: TransactionSql, f: Fixture): Promise<Outcome> {
  const label = (id: string | null): Label | null => (id === null ? null : f.labelOf.get(id) ?? null);

  const mediaRows = await tx<{ id: string }[]>`
    SELECT id FROM media WHERE tenant_id = ${f.tenantId} ORDER BY storage_key`;

  const joinRows = await tx<{ product_id: string; media_id: string; position: number }[]>`
    SELECT product_id, media_id, position FROM product_media
     WHERE tenant_id = ${f.tenantId} ORDER BY product_id, position`;

  const galleries: Outcome["galleries"] = {};
  for (const [name, id] of Object.entries(f.products)) {
    galleries[name] = joinRows
      .filter((r) => r.product_id === id)
      .map((r) => ({ media: label(r.media_id) as Label, position: r.position }));
  }

  const [category] = await tx<{ image_media_id: string | null }[]>`
    SELECT image_media_id FROM categories WHERE id = ${f.categoryId}`;
  const [collection] = await tx<{ image_media_id: string | null }[]>`
    SELECT image_media_id FROM collections WHERE id = ${f.collectionId}`;
  const [variant] = await tx<{ image_media_id: string | null }[]>`
    SELECT image_media_id FROM product_variants WHERE id = ${f.variantId}`;

  const [index] = await tx<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE indexname = 'media_tenant_checksum_idx'`;

  return {
    survivingMedia: mediaRows.flatMap((r) => {
      const l = label(r.id);
      return l ? [l] : [];
    }),
    galleries,
    categoryImage: label(category?.image_media_id ?? null),
    collectionImage: label(collection?.image_media_id ?? null),
    variantImage: label(variant?.image_media_id ?? null),
    indexDef: index?.indexdef ?? "",
    warnings: notices.flatMap((n) => (n.severity === "WARNING" && n.message ? [n.message] : [])),
  };
}

/** Thrown to roll back; anything else is a real failure. */
const ROLLBACK = new Error("rolling the migration probe back");

let outcome: Outcome;

beforeAll(async () => {
  const statements = readFileSync(MIGRATION_PATH, "utf8").split("--> statement-breakpoint");
  // Sanity: the file really is the three-statement migration, so a
  // rewrite that dropped the DDL cannot leave this suite asserting
  // against a no-op.
  expect(statements).toHaveLength(3);

  let captured: Outcome | undefined;

  try {
    await admin.begin(async (tx) => {
      // Rewind to the pre-0004 state: plain index, duplicates legal.
      await tx.unsafe(`DROP INDEX "media_tenant_checksum_idx"`);
      await tx.unsafe(
        `CREATE INDEX "media_tenant_checksum_idx" ON "media" USING btree ("tenant_id","checksum")`,
      );

      const fixture = await seed(tx);
      notices.length = 0;

      for (const statement of statements) await tx.unsafe(statement);

      captured = await observe(tx, fixture);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }

  if (!captured) throw new Error("the migration probe recorded nothing");
  outcome = captured;
});

afterAll(async () => {
  await admin.end({ timeout: 5 });
  await closeConnections();
});

describe("migration 0004 — collapsing duplicate checksums", () => {
  it("keeps one row per checksum, and the right one", async () => {
    // `ready` over unprocessed, live over soft-deleted, oldest last —
    // A_keep is the newest of its group, so "keep the oldest" fails.
    expect([...outcome.survivingMedia].sort()).toEqual([
      "A_keep",
      "B_keep",
      "no_checksum_1",
      "no_checksum_2",
    ]);
  });

  it("leaves rows with no checksum alone", async () => {
    // NULLs are distinct under a unique index. Grouping them would
    // collapse every un-hashed row in the database onto one.
    expect(outcome.survivingMedia.filter((l) => l.startsWith("no_checksum"))).toHaveLength(2);
  });

  it("de-duplicates a gallery holding the keeper and a loser", async () => {
    expect(outcome.galleries.withKeeperAndLoser).toEqual([{ media: "A_keep", position: 0 }]);
  });

  it("moves a gallery holding only a loser onto the keeper", async () => {
    expect(outcome.galleries.withLoserOnly).toEqual([{ media: "A_keep", position: 0 }]);
  });

  it("collapses a gallery holding TWO losers of one checksum", async () => {
    // The regression. Repointing each loser to the same keeper violates
    // product_media's primary key, and the migration aborted with 23505
    // — this is the topology the hand-built fixture missed. The image
    // keeps the earliest slot it held, and the second checksum's loser
    // on the same product is moved independently.
    expect(outcome.galleries.withTwoLosers).toEqual([
      { media: "A_keep", position: 0 },
      { media: "B_keep", position: 2 },
    ]);
  });

  it("repoints category, collection and variant images", async () => {
    // ON DELETE SET NULL: deleting the losers first would blank these
    // rather than move them, and nothing would say so.
    expect(outcome.categoryImage).toBe("A_keep");
    expect(outcome.collectionImage).toBe("A_keep");
    expect(outcome.variantImage).toBe("B_keep");
  });

  it("says how many rows it collapsed, loudly enough to be printed", async () => {
    // Three losers: two of CHK-A, one of CHK-B. WARNING rather than
    // NOTICE, because the runner silences NOTICE.
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain("collapsed 3 duplicate");
  });

  it("ends with the index UNIQUE", async () => {
    expect(outcome.indexDef).toContain("CREATE UNIQUE INDEX media_tenant_checksum_idx");
    expect(outcome.indexDef).toContain("(tenant_id, checksum)");
  });
});
