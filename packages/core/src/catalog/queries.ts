import {
  and,
  asc,
  categories,
  collections,
  desc,
  eq,
  inArray,
  isNull,
  media,
  productCategories,
  productMedia,
  productOptionValues,
  productOptions,
  productVariants,
  products,
  sql,
  urlSlugs,
  withTenant,
} from "@platform/db";
import type { SlugEntityType, Tx } from "@platform/db";

import { RANK_FUNCTION, SEARCH_TEXT_CONFIG, TSQUERY_FUNCTION } from "./search";
import { resolveSlug } from "./slug";
import type { SlugResolution } from "./slug";
import type { OptionAxis, OptionSelection } from "./options";

/**
 * Catalog reads for the storefront.
 *
 * Every function takes a tenantId and opens its own `withTenant`
 * transaction, so isolation is enforced by PostgreSQL rather than by
 * each caller remembering a WHERE clause. The explicit `eq(tenantId)`
 * filters you see below are therefore redundant — deliberately. They
 * cost nothing, they let the planner use the tenant-leading composite
 * indexes, and they mean a query copied into a context without RLS
 * still behaves.
 */

export type ProductCard = {
  id: string;
  title: string;
  summary: string | null;
  slug: string;
  pricePaise: number;
  compareAtPaise: number | null;
  currency: string;
  imageStorageKey: string | null;
  imageAlt: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
};

export type ProductDetail = {
  id: string;
  title: string;
  summary: string | null;
  description: string | null;
  slug: string;
  status: string;
  hsnCode: string | null;
  taxRateBps: number | null;
  seo: Record<string, unknown>;
  publishedAt: Date | null;
  updatedAt: Date;
  axes: OptionAxis[];
  variants: {
    id: string;
    sku: string;
    barcode: string | null;
    options: OptionSelection;
    pricePaise: number;
    compareAtPaise: number | null;
    currency: string;
    weightGrams: number;
    isActive: boolean;
  }[];
  images: {
    id: string;
    storageKey: string;
    alt: string | null;
    width: number | null;
    height: number | null;
    derivatives: unknown;
  }[];
  categoryIds: string[];
};

/**
 * Only published products are ever visible to the public.
 *
 * Expressed once, here, rather than repeated at each call site — a
 * listing that forgets it leaks a merchant's unfinished drafts, complete
 * with placeholder titles and test prices, onto a live storefront.
 */
function publiclyVisible(tenantId: string) {
  return and(
    eq(products.tenantId, tenantId),
    eq(products.status, "active"),
    isNull(products.deletedAt),
  );
}

/** The canonical slug for each of a set of entities, in one query. */
async function canonicalSlugs(
  tx: Tx,
  tenantId: string,
  entityType: SlugEntityType,
  entityIds: string[],
): Promise<Map<string, string>> {
  if (entityIds.length === 0) return new Map();

  const rows = await tx
    .select({ entityId: urlSlugs.entityId, slug: urlSlugs.slug })
    .from(urlSlugs)
    .where(
      and(
        eq(urlSlugs.tenantId, tenantId),
        eq(urlSlugs.entityType, entityType),
        eq(urlSlugs.isCanonical, true),
        inArray(urlSlugs.entityId, entityIds),
      ),
    );

  return new Map(rows.map((r) => [r.entityId, r.slug]));
}

/**
 * Resolves a public URL to what should happen: render, redirect or 404.
 *
 * Two lookups rather than a self-join, because the second only runs for
 * the small minority of requests that hit a historical slug.
 */
export async function resolveStorefrontSlug(
  tenantId: string,
  slug: string,
): Promise<SlugResolution> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        slug: urlSlugs.slug,
        entityType: urlSlugs.entityType,
        entityId: urlSlugs.entityId,
        isCanonical: urlSlugs.isCanonical,
      })
      .from(urlSlugs)
      .where(and(eq(urlSlugs.tenantId, tenantId), eq(urlSlugs.slug, slug)))
      .limit(1);

    if (!row) return resolveSlug(null, () => null);
    if (row.isCanonical) return resolveSlug(row, () => null);

    const canonical = await canonicalSlugs(tx, tenantId, row.entityType, [row.entityId]);
    return resolveSlug(row, (_type, id) => canonical.get(id) ?? null);
  });
}

/**
 * The outer product id, written out in full.
 *
 * Interpolating the Drizzle column does NOT work in a correlated
 * subquery. Inside a SELECT-list expression Drizzle renders a column
 * UNQUALIFIED, so interpolating `products.id` emits `v.product_id =
 * "id"`. Postgres then resolves that bare "id" against the innermost
 * scope — the subquery's own table — making the condition
 * `v.product_id = v.id`, which is never true. No error and no warning:
 * the column just comes back NULL for every row, so the storefront
 * renders priceless cards.
 *
 * Drizzle DOES qualify columns in a WHERE clause, so the same
 * interpolation is safe there. Rather than rely on the reader knowing
 * which clause they are in, every correlated reference below uses this.
 */
const OUTER_PRODUCT_ID = sql`"products"."id"`;

type CheapestVariant = {
  pricePaise: number;
  compareAtPaise: number | null;
  currency: string;
} | null;

type CardImage = {
  storageKey: string;
  alt: string | null;
  width: number | null;
  height: number | null;
} | null;

/**
 * The default variant shown before the customer chooses anything.
 *
 * Lowest active price, not lowest `position`: the PDP headline and the
 * listing card must agree, and a listing that advertises ₹499 while the
 * product page opens on the ₹1,299 variant reads as a bait-and-switch.
 *
 * Returned as one jsonb object rather than three scalar subqueries so
 * the row is located once instead of three times. Every fragment here
 * is `.as()`-aliased — an un-aliased expression comes back from
 * Postgres named `?column?`, and several of them in one SELECT collide
 * into a single result key, which surfaces as silent nulls rather than
 * as an error.
 */
const cheapestVariant = sql<CheapestVariant>`
  (SELECT jsonb_build_object(
            'pricePaise',     v.price_paise,
            'compareAtPaise', v.compare_at_paise,
            'currency',       v.currency)
     FROM product_variants v
    WHERE v.product_id = ${OUTER_PRODUCT_ID}
      AND v.deleted_at IS NULL AND v.is_active
    ORDER BY v.price_paise ASC
    LIMIT 1)`.as("cheapest_variant");

/**
 * The position-0 gallery image.
 *
 * Width and height come along because the storefront must emit explicit
 * dimensions on every image — unsized images are the easiest way to
 * fail the CLS budget in blueprint §6.2, and it cannot be fixed in CSS.
 */
const cardImage = sql<CardImage>`
  (SELECT jsonb_build_object(
            'storageKey', m.storage_key,
            'alt',        m.alt,
            'width',      m.width,
            'height',     m.height)
     FROM product_media pm
     JOIN media m ON m.id = pm.media_id
    WHERE pm.product_id = ${OUTER_PRODUCT_ID}
      AND m.status = 'ready' AND m.deleted_at IS NULL
    ORDER BY pm.position ASC
    LIMIT 1)`.as("card_image");

export type ListOptions = {
  categoryIds?: string[];
  collectionId?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

export type ProductList = {
  items: ProductCard[];
  total: number;
};

/** Listing and search share one query so their filters cannot diverge. */
export async function listProducts(
  tenantId: string,
  opts: ListOptions = {},
): Promise<ProductList> {
  const limit = Math.min(Math.max(opts.limit ?? 24, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  return withTenant(tenantId, async (tx) => {
    const filters = [publiclyVisible(tenantId)];

    if (opts.categoryIds?.length) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM product_categories pc
                     WHERE pc.product_id = ${OUTER_PRODUCT_ID}
                       AND pc.category_id IN (${sql.join(
                         opts.categoryIds.map((id) => sql`${id}::uuid`),
                         sql`, `,
                       )}))`,
      );
    }

    if (opts.collectionId) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM product_collections pc
                     WHERE pc.product_id = ${OUTER_PRODUCT_ID}
                       AND pc.collection_id = ${opts.collectionId}::uuid)`,
      );
    }

    // Parsed with the same configuration the generated column was built
    // with — see SEARCH_TEXT_CONFIG. websearch_to_tsquery is the only
    // parser safe to hand raw input; to_tsquery 500s on a stray '&'.
    const query = opts.search
      ? sql`${sql.raw(TSQUERY_FUNCTION)}(${sql.raw(`'${SEARCH_TEXT_CONFIG}'`)}, ${opts.search})`
      : null;

    if (query) filters.push(sql`${products.searchVector} @@ ${query}`);

    const where = and(...filters);

    const [{ total = 0 } = {}] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(products)
      .where(where);

    const rows = await tx
      .select({
        id: products.id,
        title: products.title,
        summary: products.summary,
        variant: cheapestVariant,
        image: cardImage,
      })
      .from(products)
      .where(where)
      .orderBy(
        // Relevance first when searching; newest first when browsing.
        ...(query
          ? [desc(sql`${sql.raw(RANK_FUNCTION)}(${products.searchVector}, ${query})`)]
          : [desc(products.publishedAt)]),
        asc(products.id),
      )
      .limit(limit)
      .offset(offset);

    const slugs = await canonicalSlugs(
      tx,
      tenantId,
      "product",
      rows.map((r) => r.id),
    );

    return {
      total,
      items: rows.flatMap((r) => {
        const slug = slugs.get(r.id);
        // A product with no canonical slug cannot be linked to, and one
        // with no active variant has no price to show. Both are dropped
        // rather than rendered as a dead or priceless card.
        if (!slug || !r.variant) return [];

        return [
          {
            id: r.id,
            title: r.title,
            summary: r.summary,
            slug,
            pricePaise: r.variant.pricePaise,
            compareAtPaise: r.variant.compareAtPaise,
            currency: r.variant.currency,
            imageStorageKey: r.image?.storageKey ?? null,
            imageAlt: r.image?.alt ?? null,
            imageWidth: r.image?.width ?? null,
            imageHeight: r.image?.height ?? null,
          },
        ];
      }),
    };
  });
}

/** Full PDP payload in one round of queries. */
export async function getProductById(
  tenantId: string,
  productId: string,
): Promise<ProductDetail | null> {
  return withTenant(tenantId, async (tx) => {
    const [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, productId), publiclyVisible(tenantId)))
      .limit(1);

    if (!product) return null;

    const [axesRows, variantRows, imageRows, categoryRows, slugs] = await Promise.all([
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
        .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)))
        .orderBy(asc(productVariants.position)),

      tx
        .select({
          id: media.id,
          storageKey: media.storageKey,
          alt: media.alt,
          width: media.width,
          height: media.height,
          derivatives: media.derivatives,
        })
        .from(productMedia)
        .innerJoin(media, eq(media.id, productMedia.mediaId))
        .where(
          and(
            eq(productMedia.productId, productId),
            eq(media.status, "ready"),
            isNull(media.deletedAt),
          ),
        )
        .orderBy(asc(productMedia.position)),

      tx
        .select({ categoryId: productCategories.categoryId })
        .from(productCategories)
        .where(eq(productCategories.productId, productId)),

      canonicalSlugs(tx, tenantId, "product", [productId]),
    ]);

    const slug = slugs.get(productId);
    if (!slug) return null;

    // Collapse the option/value join back into axes, preserving order.
    const axes: OptionAxis[] = [];
    for (const row of axesRows) {
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
      summary: product.summary,
      description: product.description,
      slug,
      status: product.status,
      hsnCode: product.hsnCode,
      taxRateBps: product.taxRateBps,
      seo: (product.seo ?? {}) as Record<string, unknown>,
      publishedAt: product.publishedAt,
      updatedAt: product.updatedAt,
      axes,
      variants: variantRows.map((v) => ({
        id: v.id,
        sku: v.sku,
        barcode: v.barcode,
        options: (v.options ?? {}) as OptionSelection,
        pricePaise: v.pricePaise,
        compareAtPaise: v.compareAtPaise,
        currency: v.currency,
        weightGrams: v.weightGrams,
        isActive: v.isActive,
      })),
      images: imageRows,
      categoryIds: categoryRows.map((c) => c.categoryId),
    };
  });
}

export type CategorySummary = {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
  position: number;
  slug: string;
  seo: Record<string, unknown>;
};

/**
 * Every visible category with its canonical slug.
 *
 * The whole tree in one query: it is a few hundred rows at the very top
 * end, and navigation, breadcrumbs and the sitemap all need it, so
 * fetching it per-page beats a recursive CTE per breadcrumb.
 */
export async function listCategories(tenantId: string): Promise<CategorySummary[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: categories.id,
        parentId: categories.parentId,
        title: categories.title,
        description: categories.description,
        position: categories.position,
        seo: categories.seo,
      })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, tenantId),
          eq(categories.isVisible, true),
          isNull(categories.deletedAt),
        ),
      )
      .orderBy(asc(categories.position), asc(categories.title));

    const slugs = await canonicalSlugs(
      tx,
      tenantId,
      "category",
      rows.map((r) => r.id),
    );

    return rows.flatMap((r) => {
      const slug = slugs.get(r.id);
      return slug ? [{ ...r, slug, seo: (r.seo ?? {}) as Record<string, unknown> }] : [];
    });
  });
}

export async function getCategoryById(
  tenantId: string,
  categoryId: string,
): Promise<CategorySummary | null> {
  const all = await listCategories(tenantId);
  return all.find((c) => c.id === categoryId) ?? null;
}

export type CollectionSummary = {
  id: string;
  title: string;
  description: string | null;
  slug: string;
  seo: Record<string, unknown>;
};

export async function getCollectionById(
  tenantId: string,
  collectionId: string,
): Promise<CollectionSummary | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: collections.id,
        title: collections.title,
        description: collections.description,
        seo: collections.seo,
      })
      .from(collections)
      .where(
        and(
          eq(collections.id, collectionId),
          eq(collections.isVisible, true),
          isNull(collections.deletedAt),
        ),
      )
      .limit(1);

    if (!row) return null;

    const slugs = await canonicalSlugs(tx, tenantId, "collection", [row.id]);
    const slug = slugs.get(row.id);
    return slug ? { ...row, slug, seo: (row.seo ?? {}) as Record<string, unknown> } : null;
  });
}

/**
 * Every public URL for a tenant, for sitemap generation.
 *
 * Canonical slugs only — historical ones redirect and must never appear in a
 * sitemap, which is a statement of what should be indexed.
 */
export async function listSitemapEntries(
  tenantId: string,
): Promise<{ slug: string; entityType: string; updatedAt: Date }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ slug: string; entity_type: string; updated_at: Date }>(
      sql`
        SELECT u.slug, u.entity_type, p.updated_at
          FROM url_slugs u
          JOIN products p ON p.id = u.entity_id
         WHERE u.tenant_id = ${tenantId} AND u.is_canonical
           AND u.entity_type = 'product'
           AND p.status = 'active' AND p.deleted_at IS NULL
        UNION ALL
        SELECT u.slug, u.entity_type, c.updated_at
          FROM url_slugs u
          JOIN categories c ON c.id = u.entity_id
         WHERE u.tenant_id = ${tenantId} AND u.is_canonical
           AND u.entity_type = 'category'
           AND c.is_visible AND c.deleted_at IS NULL
        UNION ALL
        SELECT u.slug, u.entity_type, col.updated_at
          FROM url_slugs u
          JOIN collections col ON col.id = u.entity_id
         WHERE u.tenant_id = ${tenantId} AND u.is_canonical
           AND u.entity_type = 'collection'
           AND col.is_visible AND col.deleted_at IS NULL
        ORDER BY updated_at DESC`,
    );

    // `tx.execute` returns DRIVER-level rows: no camelCase mapping and
    // no type decoding, so a timestamptz arrives as a string. Handing
    // that straight to a sitemap writer produces a `lastmod` the
    // formatter silently mangles, so it is converted here rather than
    // trusted to be a Date because the type annotation says so.
    return (rows as unknown as { slug: string; entity_type: string; updated_at: string }[]).map(
      (r) => ({
        slug: r.slug,
        entityType: r.entity_type,
        updatedAt: new Date(r.updated_at),
      }),
    );
  });
}
