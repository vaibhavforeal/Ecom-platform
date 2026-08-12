import {
  and,
  asc,
  categories,
  collections,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  media,
  or,
  productCategories,
  productCollections,
  productMedia,
  productOptionValues,
  productOptions,
  productVariants,
  products,
  sql,
  urlSlugs,
  withTenant,
} from "@platform/db";
import type { MediaStatus, ProductStatus, Tx } from "@platform/db";

import type { OptionAxis, OptionSelection } from "./options";

/**
 * Catalog reads for the CONSOLE. SERVER ONLY.
 *
 * Separate from `queries.ts`, which serves the storefront, because the
 * audiences want opposite things. The storefront must never see a draft;
 * the console must see everything the merchant owns, including drafts,
 * archived products, variants that are switched off and images the
 * worker has not finished processing. Sharing one query and adding a
 * `includeDrafts` flag is how a listing eventually leaks an unfinished
 * product with a placeholder title onto a live store.
 *
 * These deliberately avoid correlated subqueries in the SELECT list.
 * `queries.ts` documents why that construct is a trap (an unqualified
 * column silently resolves against the subquery's own table); a page of
 * twenty-five products is small enough that a second grouped query is
 * both faster to read and impossible to get wrong that way.
 */

export type ConsoleProductRow = {
  id: string;
  title: string;
  slug: string | null;
  status: ProductStatus;
  updatedAt: Date;
  variantCount: number;
  minPricePaise: number | null;
  maxPricePaise: number | null;
  currency: string;
  image: { storageKey: string; status: MediaStatus; alt: string | null } | null;
};

export type ConsoleProductListOptions = {
  /** Matched against the title and against variant SKUs. */
  search?: string;
  status?: ProductStatus | "all";
  limit?: number;
  offset?: number;
};

export const CONSOLE_PAGE_SIZE = 25;

/** LIKE metacharacters in merchant input are literals, not wildcards. */
function likeLiteral(input: string): string {
  return `%${input.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The canonical slug for a set of products, in one query. */
async function slugsFor(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ entityId: urlSlugs.entityId, slug: urlSlugs.slug })
    .from(urlSlugs)
    .where(
      and(
        eq(urlSlugs.tenantId, tenantId),
        eq(urlSlugs.entityType, "product"),
        eq(urlSlugs.isCanonical, true),
        inArray(urlSlugs.entityId, ids),
      ),
    );
  return new Map(rows.map((r) => [r.entityId, r.slug]));
}

export async function listProductsForConsole(
  tenantId: string,
  opts: ConsoleProductListOptions = {},
): Promise<{ items: ConsoleProductRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? CONSOLE_PAGE_SIZE, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const search = opts.search?.trim();

  return withTenant(tenantId, async (tx) => {
    const filters = [eq(products.tenantId, tenantId), isNull(products.deletedAt)];

    if (opts.status && opts.status !== "all") {
      filters.push(eq(products.status, opts.status));
    }

    if (search) {
      const pattern = likeLiteral(search);
      // Title OR SKU. Merchants search for both, and a merchant who
      // types a SKU into a product search and gets nothing concludes the
      // product is missing.
      filters.push(
        or(
          ilike(products.title, pattern),
          sql`EXISTS (SELECT 1 FROM product_variants v
                       WHERE v.product_id = "products"."id"
                         AND v.deleted_at IS NULL
                         AND v.sku ILIKE ${pattern})`,
        )!,
      );
    }

    const where = and(...filters);

    const [{ total = 0 } = {}] = await tx
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(products)
      .where(where);

    const rows = await tx
      .select({
        id: products.id,
        title: products.title,
        status: products.status,
        updatedAt: products.updatedAt,
      })
      .from(products)
      .where(where)
      .orderBy(desc(products.updatedAt), asc(products.id))
      .limit(limit)
      .offset(offset);

    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return { items: [], total };

    const [priceRows, imageRows, slugs] = await Promise.all([
      tx
        .select({
          productId: productVariants.productId,
          count: sql<number>`count(*)::int`.as("variant_count"),
          minPrice: sql<number>`min(${productVariants.pricePaise})::bigint`.as("min_price"),
          maxPrice: sql<number>`max(${productVariants.pricePaise})::bigint`.as("max_price"),
          currency: sql<string>`min(${productVariants.currency})`.as("currency"),
        })
        .from(productVariants)
        .where(
          and(inArray(productVariants.productId, ids), isNull(productVariants.deletedAt)),
        )
        .groupBy(productVariants.productId),

      tx
        .select({
          productId: productMedia.productId,
          position: productMedia.position,
          storageKey: media.storageKey,
          status: media.status,
          alt: media.alt,
        })
        .from(productMedia)
        .innerJoin(media, eq(media.id, productMedia.mediaId))
        .where(and(inArray(productMedia.productId, ids), isNull(media.deletedAt)))
        .orderBy(asc(productMedia.position)),

      slugsFor(tx, tenantId, ids),
    ]);

    const prices = new Map(priceRows.map((r) => [r.productId, r]));
    const images = new Map<string, (typeof imageRows)[number]>();
    for (const row of imageRows) {
      if (!images.has(row.productId)) images.set(row.productId, row);
    }

    return {
      total,
      items: rows.map((row) => {
        const price = prices.get(row.id);
        const image = images.get(row.id);
        return {
          id: row.id,
          title: row.title,
          slug: slugs.get(row.id) ?? null,
          status: row.status,
          updatedAt: row.updatedAt,
          variantCount: price?.count ?? 0,
          // `min()`/`max()` over bigint come back as strings from the
          // driver; Number() at the boundary rather than a cast that
          // only looks like one to TypeScript.
          minPricePaise: price ? Number(price.minPrice) : null,
          maxPricePaise: price ? Number(price.maxPrice) : null,
          currency: price?.currency ?? "INR",
          image: image
            ? { storageKey: image.storageKey, status: image.status, alt: image.alt }
            : null,
        };
      }),
    };
  });
}

export type ConsoleVariant = {
  id: string;
  sku: string;
  barcode: string | null;
  options: OptionSelection;
  pricePaise: number;
  compareAtPaise: number | null;
  costPaise: number | null;
  currency: string;
  weightGrams: number;
  lowStockAt: number | null;
  imageMediaId: string | null;
  isActive: boolean;
};

export type ConsoleMedia = {
  id: string;
  storageKey: string;
  alt: string | null;
  status: MediaStatus;
  width: number | null;
  height: number | null;
  processingError: string | null;
};

export type ConsoleProduct = {
  id: string;
  title: string;
  slug: string | null;
  /** Superseded slugs, newest first. These still redirect. */
  historicalSlugs: string[];
  summary: string | null;
  /** Already sanitised — it was sanitised on the way into the column. */
  description: string | null;
  status: ProductStatus;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  hsnCode: string | null;
  taxRateBps: number | null;
  seo: Record<string, unknown>;
  axes: OptionAxis[];
  variants: ConsoleVariant[];
  media: ConsoleMedia[];
  categoryIds: string[];
  collectionIds: string[];
};

/** Everything the edit form needs, at any status. */
export async function getProductForConsole(
  tenantId: string,
  productId: string,
): Promise<ConsoleProduct | null> {
  return withTenant(tenantId, async (tx) => {
    const [product] = await tx
      .select()
      .from(products)
      .where(
        and(
          eq(products.tenantId, tenantId),
          eq(products.id, productId),
          isNull(products.deletedAt),
        ),
      )
      .limit(1);

    if (!product) return null;

    const [axisRows, variantRows, mediaRows, categoryRows, collectionRows, slugRows] =
      await Promise.all([
        tx
          .select({
            name: productOptions.name,
            position: productOptions.position,
            value: productOptionValues.value,
            valuePosition: productOptionValues.position,
          })
          .from(productOptions)
          .leftJoin(productOptionValues, eq(productOptionValues.optionId, productOptions.id))
          .where(eq(productOptions.productId, productId))
          .orderBy(asc(productOptions.position), asc(productOptionValues.position)),

        tx
          .select()
          .from(productVariants)
          .where(
            and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)),
          )
          .orderBy(asc(productVariants.position)),

        // No `status = 'ready'` filter, unlike the storefront: the
        // merchant needs to see that an image is still processing or has
        // failed, not have it silently missing from their own gallery.
        tx
          .select({
            id: media.id,
            storageKey: media.storageKey,
            alt: media.alt,
            status: media.status,
            width: media.width,
            height: media.height,
            processingError: media.processingError,
          })
          .from(productMedia)
          .innerJoin(media, eq(media.id, productMedia.mediaId))
          .where(and(eq(productMedia.productId, productId), isNull(media.deletedAt)))
          .orderBy(asc(productMedia.position)),

        tx
          .select({ id: productCategories.categoryId })
          .from(productCategories)
          .where(eq(productCategories.productId, productId))
          .orderBy(asc(productCategories.position)),

        tx
          .select({ id: productCollections.collectionId })
          .from(productCollections)
          .where(eq(productCollections.productId, productId))
          .orderBy(asc(productCollections.position)),

        tx
          .select({ slug: urlSlugs.slug, isCanonical: urlSlugs.isCanonical })
          .from(urlSlugs)
          .where(
            and(
              eq(urlSlugs.tenantId, tenantId),
              eq(urlSlugs.entityType, "product"),
              eq(urlSlugs.entityId, productId),
            ),
          )
          .orderBy(desc(urlSlugs.createdAt)),
      ]);

    const axes: OptionAxis[] = [];
    for (const row of axisRows) {
      let axis = axes.find((a) => a.name === row.name);
      if (!axis) {
        axis = { name: row.name, values: [] };
        axes.push(axis);
      }
      if (row.value !== null && !axis.values.includes(row.value)) axis.values.push(row.value);
    }

    return {
      id: product.id,
      title: product.title,
      slug: slugRows.find((s) => s.isCanonical)?.slug ?? null,
      historicalSlugs: slugRows.filter((s) => !s.isCanonical).map((s) => s.slug),
      summary: product.summary,
      description: product.description,
      status: product.status,
      productType: product.productType,
      vendor: product.vendor,
      tags: Array.isArray(product.tags) ? (product.tags as string[]) : [],
      hsnCode: product.hsnCode,
      taxRateBps: product.taxRateBps,
      seo: (product.seo ?? {}) as Record<string, unknown>,
      axes,
      variants: variantRows.map((v) => ({
        id: v.id,
        sku: v.sku,
        barcode: v.barcode,
        options: (v.options ?? {}) as OptionSelection,
        pricePaise: v.pricePaise,
        compareAtPaise: v.compareAtPaise,
        costPaise: v.costPaise,
        currency: v.currency,
        weightGrams: v.weightGrams,
        lowStockAt: v.lowStockAt,
        imageMediaId: v.imageMediaId,
        isActive: v.isActive,
      })),
      media: mediaRows,
      categoryIds: categoryRows.map((r) => r.id),
      collectionIds: collectionRows.map((r) => r.id),
    };
  });
}

export type ConsoleTaxonomyRow = {
  id: string;
  title: string;
  slug: string | null;
  description: string | null;
  parentId: string | null;
  position: number;
  isVisible: boolean;
  productCount: number;
};

/**
 * Categories and collections as the console needs them — hidden ones
 * included, each with how many products are filed under it.
 *
 * `listCategories` in queries.ts filters `is_visible`, which is right
 * for a storefront and wrong here: a merchant who hides a category must
 * still be able to find it again to unhide it.
 */
export async function listTaxonomyForConsole(tenantId: string): Promise<{
  categories: ConsoleTaxonomyRow[];
  collections: ConsoleTaxonomyRow[];
}> {
  return withTenant(tenantId, async (tx) => {
    const [categoryRows, collectionRows, categoryCounts, collectionCounts, slugRows] =
      await Promise.all([
        tx
          .select()
          .from(categories)
          .where(and(eq(categories.tenantId, tenantId), isNull(categories.deletedAt)))
          .orderBy(asc(categories.position), asc(categories.title)),

        tx
          .select()
          .from(collections)
          .where(and(eq(collections.tenantId, tenantId), isNull(collections.deletedAt)))
          .orderBy(asc(collections.position), asc(collections.title)),

        tx
          .select({
            id: productCategories.categoryId,
            count: sql<number>`count(*)::int`.as("product_count"),
          })
          .from(productCategories)
          .where(eq(productCategories.tenantId, tenantId))
          .groupBy(productCategories.categoryId),

        tx
          .select({
            id: productCollections.collectionId,
            count: sql<number>`count(*)::int`.as("product_count"),
          })
          .from(productCollections)
          .where(eq(productCollections.tenantId, tenantId))
          .groupBy(productCollections.collectionId),

        tx
          .select({
            entityType: urlSlugs.entityType,
            entityId: urlSlugs.entityId,
            slug: urlSlugs.slug,
          })
          .from(urlSlugs)
          .where(and(eq(urlSlugs.tenantId, tenantId), eq(urlSlugs.isCanonical, true))),
      ]);

    const slugs = new Map(slugRows.map((r) => [`${r.entityType}:${r.entityId}`, r.slug]));
    const categoryCount = new Map(categoryCounts.map((r) => [r.id, r.count]));
    const collectionCount = new Map(collectionCounts.map((r) => [r.id, r.count]));

    return {
      categories: categoryRows.map((c) => ({
        id: c.id,
        title: c.title,
        slug: slugs.get(`category:${c.id}`) ?? null,
        description: c.description,
        parentId: c.parentId,
        position: c.position,
        isVisible: c.isVisible,
        productCount: categoryCount.get(c.id) ?? 0,
      })),
      collections: collectionRows.map((c) => ({
        id: c.id,
        title: c.title,
        slug: slugs.get(`collection:${c.id}`) ?? null,
        description: c.description,
        parentId: null,
        position: c.position,
        isVisible: c.isVisible,
        productCount: collectionCount.get(c.id) ?? 0,
      })),
    };
  });
}

/** The tenant's uploads, newest first, for the gallery picker. */
export async function listMediaForConsole(
  tenantId: string,
  limit = 60,
): Promise<ConsoleMedia[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select({
        id: media.id,
        storageKey: media.storageKey,
        alt: media.alt,
        status: media.status,
        width: media.width,
        height: media.height,
        processingError: media.processingError,
      })
      .from(media)
      .where(and(eq(media.tenantId, tenantId), isNull(media.deletedAt)))
      .orderBy(desc(media.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200)),
  );
}
