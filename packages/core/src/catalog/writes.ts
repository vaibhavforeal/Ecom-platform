import {
  and,
  categories,
  collections,
  eq,
  inArray,
  isNull,
  media,
  ne,
  productCategories,
  productCollections,
  productMedia,
  productOptionValues,
  productOptions,
  productVariants,
  products,
  urlSlugs,
  withTenant,
} from "@platform/db";
import type { ProductStatus, SlugEntityType, Tx } from "@platform/db";

import { recordAudit } from "../audit/index";
import { AppError } from "../errors";
import { isDescendant } from "./categories";
import { validateVariantMatrix } from "./options";
import type { OptionAxis, OptionSelection } from "./options";
import { sanitizeDescriptionHtml } from "./sanitize-html";
import { availableSlug, slugify } from "./slug";

/**
 * Catalog authoring. SERVER ONLY.
 *
 * Every function here opens its own `withTenant` transaction, so the
 * tenant is enforced by PostgreSQL rather than by each caller
 * remembering a WHERE clause — and the tenant id comes from the caller's
 * SESSION, never from the payload. The console route handlers are thin
 * wrappers around these; Task 5's CSV importer will be another, which is
 * why the rules live here and not in a route.
 *
 * Three invariants this file exists to hold:
 *
 *  1. **Descriptions are sanitised on the way in.** Not in the route
 *     handler: a second writer (import, a future AI rewriter) would have
 *     to remember, and the one that forgets is the stored-XSS incident.
 *     Doing it here means the raw string cannot reach the column.
 *
 *  2. **Slugs move through `setCanonicalSlug`.** Renaming a product
 *     demotes its old slug rather than deleting it, so every URL the
 *     store has ever served keeps redirecting.
 *
 *  3. **Foreign ids are checked for tenancy explicitly.** PostgreSQL
 *     checks foreign keys as the table owner with row security bypassed,
 *     so a `mediaId` belonging to another merchant would satisfy the FK
 *     and attach cleanly. RLS does NOT close this; the SELECTs below do.
 */

// ───────────────────────────────────────────────────────────────
// Errors
// ───────────────────────────────────────────────────────────────

export type CatalogIssue = {
  /** Dot path into the submitted payload: `variants.2.sku`. */
  path: string;
  message: string;
};

/**
 * A payload that parsed but does not describe a saveable product.
 *
 * 422 rather than 400: the request was well-formed, its content was not.
 * Every issue is returned at once — a merchant fixing a 40-variant
 * product one error per save is a merchant who stops using the console.
 */
export class CatalogValidationError extends AppError {
  constructor(issues: CatalogIssue[]) {
    super({
      code: "catalog_invalid",
      // The internal message names the paths for the log; `details` is
      // what crosses the wire, and it is safe to — every string in it
      // was written here, not echoed from the payload.
      message: `Catalog payload rejected: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      status: 422,
      publicMessage: "Some fields need attention.",
      details: { issues },
    });
  }
}

export class ProductNotFoundError extends AppError {
  constructor(productId: string) {
    super({
      code: "not_found",
      message: `Product ${productId} not found in this tenant`,
      status: 404,
      publicMessage: "That product does not exist.",
    });
  }
}

export class TaxonomyNotFoundError extends AppError {
  constructor(kind: "category" | "collection", id: string) {
    super({
      code: "not_found",
      message: `${kind} ${id} not found in this tenant`,
      status: 404,
      publicMessage: `That ${kind} does not exist.`,
    });
  }
}

// ───────────────────────────────────────────────────────────────
// Shapes
// ───────────────────────────────────────────────────────────────

/** Who is writing, for the audit row. Never carries a tenant from a form. */
export type WriteContext = {
  tenantId: string;
  actorUserId: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};

export type VariantInput = {
  /**
   * The existing variant being edited, or null for a new one. An id that
   * does not belong to this product is treated as new rather than
   * trusted — see `updateProduct`.
   */
  id?: string | null;
  sku: string;
  barcode: string | null;
  options: OptionSelection;
  /** Integer paise. Never a float, never a rupee string. */
  pricePaise: number;
  compareAtPaise: number | null;
  costPaise: number | null;
  weightGrams: number;
  lowStockAt: number | null;
  imageMediaId: string | null;
  isActive: boolean;
};

export type ProductMediaInput = {
  mediaId: string;
  /** Written through to `media.alt`; null leaves the existing text alone. */
  alt: string | null;
};

export type ProductSeoInput = {
  title?: string | null;
  description?: string | null;
  noindex?: boolean;
};

export type ProductWriteInput = {
  title: string;
  /** Desired slug. Derived from the title when blank. */
  slug?: string | null;
  summary: string | null;
  /** RAW merchant HTML. Sanitised here, before it reaches the column. */
  description: string | null;
  status: ProductStatus;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  hsnCode: string | null;
  taxRateBps: number | null;
  seo: ProductSeoInput;
  axes: OptionAxis[];
  variants: VariantInput[];
  categoryIds: string[];
  collectionIds: string[];
  media: ProductMediaInput[];
};

export type ProductWriteResult = {
  productId: string;
  slug: string;
  /** The slug this product had before the write, if it changed. */
  previousSlug: string | null;
};

// ───────────────────────────────────────────────────────────────
// Slug history
// ───────────────────────────────────────────────────────────────

/**
 * Points an entity's canonical URL at `desired`, keeping the old one.
 *
 * The whole value of `url_slugs` is in what this function does NOT do:
 * it never deletes a row. A superseded slug stays with
 * `is_canonical = false` and the storefront permanently redirects it, so
 * a merchant fixing a typo in a title does not 404 a page that took
 * months to rank.
 *
 * Order matters. `url_slugs_one_canonical_key` is a partial unique index
 * over (tenant, entity_type, entity_id) WHERE is_canonical, and it is
 * not deferrable — so the old canonical row must be demoted before the
 * new one is promoted. Both happen in the caller's transaction, so no
 * reader ever observes an entity with two canonical slugs or none.
 */
export async function setCanonicalSlug(
  tx: Tx,
  tenantId: string,
  entityType: SlugEntityType,
  entityId: string,
  desired: string,
): Promise<{ slug: string; previous: string | null }> {
  const [current] = await tx
    .select({ slug: urlSlugs.slug })
    .from(urlSlugs)
    .where(
      and(
        eq(urlSlugs.tenantId, tenantId),
        eq(urlSlugs.entityType, entityType),
        eq(urlSlugs.entityId, entityId),
        eq(urlSlugs.isCanonical, true),
      ),
    )
    .limit(1);

  const base = slugify(desired, { fallback: "item" });

  /**
   * A slug is "taken" only by a DIFFERENT entity. One this entity has
   * used before is free — reclaiming your own old URL is exactly what a
   * merchant who undoes a rename expects, and treating it as taken would
   * silently hand them `shirt-2`.
   */
  const slug = await availableSlug(base, async (candidate) => {
    const [row] = await tx
      .select({ entityId: urlSlugs.entityId })
      .from(urlSlugs)
      .where(and(eq(urlSlugs.tenantId, tenantId), eq(urlSlugs.slug, candidate)))
      .limit(1);
    return row !== undefined && row.entityId !== entityId;
  });

  if (current?.slug === slug) return { slug, previous: null };

  await tx
    .update(urlSlugs)
    .set({ isCanonical: false })
    .where(
      and(
        eq(urlSlugs.tenantId, tenantId),
        eq(urlSlugs.entityType, entityType),
        eq(urlSlugs.entityId, entityId),
        eq(urlSlugs.isCanonical, true),
      ),
    );

  const promoted = await tx
    .insert(urlSlugs)
    .values({ tenantId, slug, entityType, entityId, isCanonical: true })
    .onConflictDoUpdate({
      target: [urlSlugs.tenantId, urlSlugs.slug],
      set: { isCanonical: true },
      // Belt and braces on top of `availableSlug`: even if the
      // availability probe were wrong, this refuses to reassign another
      // entity's URL rather than silently stealing it.
      setWhere: eq(urlSlugs.entityId, entityId),
    })
    .returning({ slug: urlSlugs.slug });

  if (promoted.length === 0) {
    throw new CatalogValidationError([
      { path: "slug", message: `The URL "${slug}" is already in use.` },
    ]);
  }

  return { slug, previous: current?.slug ?? null };
}

// ───────────────────────────────────────────────────────────────
// Tenancy checks for foreign ids
// ───────────────────────────────────────────────────────────────

/**
 * Refuses ids that this tenant cannot see.
 *
 * Called for every id the payload names. Without it, a merchant could
 * attach another merchant's photograph to their own product: the foreign
 * key is validated by PostgreSQL as the table owner, which bypasses row
 * security, so the insert would succeed and nothing would look wrong.
 */
function assertVisible(
  found: { id: string }[],
  requested: string[],
  path: string,
  label: string,
): void {
  if (requested.length === 0) return;
  const visible = new Set(found.map((r) => r.id));
  const missing = requested.filter((id) => !visible.has(id));
  if (missing.length > 0) {
    throw new CatalogValidationError(
      missing.map((id) => ({ path, message: `${label} ${id} does not exist in this store.` })),
    );
  }
}

async function assertMediaVisible(tx: Tx, tenantId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.tenantId, tenantId), inArray(media.id, ids), isNull(media.deletedAt)));
  assertVisible(rows, ids, "media", "Image");
}

async function assertTaxonomyVisible(
  tx: Tx,
  tenantId: string,
  categoryIds: string[],
  collectionIds: string[],
): Promise<void> {
  if (categoryIds.length > 0) {
    const rows = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, tenantId),
          inArray(categories.id, categoryIds),
          isNull(categories.deletedAt),
        ),
      );
    assertVisible(rows, categoryIds, "categoryIds", "Category");
  }

  if (collectionIds.length > 0) {
    const rows = await tx
      .select({ id: collections.id })
      .from(collections)
      .where(
        and(
          eq(collections.tenantId, tenantId),
          inArray(collections.id, collectionIds),
          isNull(collections.deletedAt),
        ),
      );
    assertVisible(rows, collectionIds, "collectionIds", "Collection");
  }
}

// ───────────────────────────────────────────────────────────────
// Validation
// ───────────────────────────────────────────────────────────────

/** Matrix issues, mapped onto the payload paths the form can highlight. */
function matrixIssues(input: ProductWriteInput): CatalogIssue[] {
  return validateVariantMatrix(input.axes, input.variants).map((issue) => ({
    path: issue.variantIndex === undefined ? "axes" : `variants.${issue.variantIndex}`,
    message: issue.message,
  }));
}

/**
 * SKUs, which are unique per tenant rather than per product.
 *
 * Checked here so a collision returns a labelled field error instead of
 * a 500 from `product_variants_tenant_sku_key`. Two scopes: within the
 * submitted set, and against every other live variant in the store.
 */
async function skuIssues(
  tx: Tx,
  tenantId: string,
  productId: string | null,
  variants: VariantInput[],
): Promise<CatalogIssue[]> {
  const issues: CatalogIssue[] = [];

  const seen = new Map<string, number>();
  variants.forEach((v, i) => {
    const first = seen.get(v.sku);
    if (first !== undefined) {
      issues.push({ path: `variants.${i}.sku`, message: `SKU "${v.sku}" is used twice.` });
    } else {
      seen.set(v.sku, i);
    }
  });

  const skus = [...seen.keys()];
  if (skus.length === 0) return issues;

  const clashes = await tx
    .select({ sku: productVariants.sku })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.tenantId, tenantId),
        inArray(productVariants.sku, skus),
        isNull(productVariants.deletedAt),
        ...(productId ? [ne(productVariants.productId, productId)] : []),
      ),
    );

  for (const clash of clashes) {
    const index = seen.get(clash.sku);
    if (index !== undefined) {
      issues.push({
        path: `variants.${index}.sku`,
        message: `SKU "${clash.sku}" already belongs to another product.`,
      });
    }
  }

  return issues;
}

// ───────────────────────────────────────────────────────────────
// Child rows
// ───────────────────────────────────────────────────────────────

/**
 * Replaces a product's declared axes wholesale.
 *
 * Options and their values are pure declaration — nothing outside this
 * product references their ids — so replacing them is simpler and more
 * obviously correct than diffing. Values cascade from the option row.
 */
async function writeOptions(
  tx: Tx,
  tenantId: string,
  productId: string,
  axes: OptionAxis[],
): Promise<void> {
  await tx.delete(productOptions).where(eq(productOptions.productId, productId));

  for (const [position, axis] of axes.entries()) {
    const [option] = await tx
      .insert(productOptions)
      .values({ tenantId, productId, name: axis.name, position })
      .returning({ id: productOptions.id });

    if (!option) throw new Error("product_options insert returned no row");
    if (axis.values.length === 0) continue;

    await tx.insert(productOptionValues).values(
      axis.values.map((value, i) => ({
        tenantId,
        optionId: option.id,
        value,
        position: i,
      })),
    );
  }
}

/**
 * Replaces a product's variant set, keeping ids for the ones that stay.
 *
 * Variants are SOFT-deleted, never hard-deleted: an order line will
 * reference one from Phase 2, and a variant that vanishes takes the
 * order history's product name and price with it.
 *
 * Every live variant is soft-deleted FIRST, then the kept ones are
 * revived. That ordering is not tidiness — `product_variants_sku_key`
 * and `product_variants_option_combo_key` are partial unique indexes
 * over `deleted_at IS NULL`, so any save that swaps two variants' SKUs
 * or option combinations collides mid-update if the rows are edited in
 * place. Clearing the live set first means the only rows the indexes can
 * see are the ones being written, and the submitted set is already known
 * to be internally unique.
 */
async function writeVariants(
  tx: Tx,
  tenantId: string,
  productId: string,
  variants: VariantInput[],
  actorUserId: string,
  isCreate: boolean,
): Promise<void> {
  const now = new Date();

  const live = await tx
    .select({ id: productVariants.id, sku: productVariants.sku })
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)));

  const ownIds = new Set(live.map((v) => v.id));
  const bySku = new Map(live.map((v) => [v.sku, v.id]));

  if (ownIds.size > 0) {
    await tx
      .update(productVariants)
      .set({ deletedAt: now, updatedAt: now, updatedByUserId: actorUserId })
      .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)));
  }

  /**
   * Which existing row each submitted variant edits.
   *
   * The id when the payload carries one, and the SKU when it does not —
   * the console's form always sends ids, but a CSV import identifies a
   * variant the only way a spreadsheet can. Without the SKU fallback,
   * re-importing an unchanged file would soft-delete and re-create every
   * variant in the store: no visible difference in the catalog, and
   * every order line in Phase 2 left pointing at a dead row.
   *
   * TWO PASSES, and the order is the whole point. Resolving in payload
   * order lets an id-less row claim by SKU a variant that a LATER row
   * names explicitly by id — so given live V1(sku "A") and V2(sku "B"),
   * the payload [{sku:"B"}, {id:V2, sku:"C"}] would hand V2 to index 0
   * and insert "C" fresh, which is the opposite of what was asked. An
   * explicit id is the stronger statement of intent, so every id-based
   * claim is settled before any SKU is looked at.
   *
   * A row is claimed once either way. Two submitted variants naming the
   * same existing one would otherwise both update it and lose the first.
   */
  const targets: (string | null)[] = new Array<string | null>(variants.length).fill(null);
  const claimed = new Set<string>();

  variants.forEach((variant, i) => {
    if (variant.id && ownIds.has(variant.id) && !claimed.has(variant.id)) {
      claimed.add(variant.id);
      targets[i] = variant.id;
    }
  });

  variants.forEach((variant, i) => {
    if (targets[i] !== null) return;
    const bySkuMatch = bySku.get(variant.sku);
    if (bySkuMatch !== undefined && !claimed.has(bySkuMatch)) {
      claimed.add(bySkuMatch);
      targets[i] = bySkuMatch;
    }
  });

  for (const [position, variant] of variants.entries()) {
    const columns = {
      sku: variant.sku,
      barcode: variant.barcode,
      options: variant.options,
      pricePaise: variant.pricePaise,
      compareAtPaise: variant.compareAtPaise,
      costPaise: variant.costPaise,
      weightGrams: variant.weightGrams,
      lowStockAt: variant.lowStockAt,
      imageMediaId: variant.imageMediaId,
      isActive: variant.isActive,
      position,
    };

    // An id is honoured only if it names a variant of THIS product — a
    // payload pointing at someone else's variant creates a new row here
    // rather than editing theirs.
    const target = targets[position];
    if (target) {
      await tx
        .update(productVariants)
        .set({ ...columns, deletedAt: null, updatedAt: now, updatedByUserId: actorUserId })
        .where(eq(productVariants.id, target));
    } else {
      await tx.insert(productVariants).values({
        ...columns,
        tenantId,
        productId,
        createdByUserId: actorUserId,
        updatedByUserId: isCreate ? null : actorUserId,
      });
    }
  }
}

/**
 * Membership is a SET, and is deduplicated here rather than at the
 * request boundary.
 *
 * `product_categories` and `product_collections` are keyed on
 * (tenant, product, category|collection), so the same id twice is a
 * duplicate-key violation — which surfaces as an unexplained 500 rather
 * than as anything a merchant can act on. Deduplicating in the zod
 * schema would fix the console and leave the hole open for Task 5's CSV
 * importer, which calls this function directly.
 *
 * Silently, not as an error: naming a category twice is redundant, not
 * wrong, and there is nothing useful to tell someone about it.
 */
async function writeMembership(
  tx: Tx,
  tenantId: string,
  productId: string,
  categoryIds: string[],
  collectionIds: string[],
): Promise<void> {
  const categoryIdSet = [...new Set(categoryIds)];
  const collectionIdSet = [...new Set(collectionIds)];

  await tx.delete(productCategories).where(eq(productCategories.productId, productId));
  if (categoryIdSet.length > 0) {
    await tx.insert(productCategories).values(
      categoryIdSet.map((categoryId, position) => ({ tenantId, productId, categoryId, position })),
    );
  }

  await tx.delete(productCollections).where(eq(productCollections.productId, productId));
  if (collectionIdSet.length > 0) {
    await tx.insert(productCollections).values(
      collectionIdSet.map((collectionId, position) => ({
        tenantId,
        productId,
        collectionId,
        position,
      })),
    );
  }
}

/**
 * Rewrites the gallery, and the alt text of the images in it.
 *
 * `alt` lives on `media`, not on the join, because it describes the
 * PICTURE rather than its use on one page — the same photograph on three
 * products should not need the same sentence typed three times. Passing
 * null leaves whatever is already there.
 *
 * Deduplicated on `mediaId` for the same reason as `writeMembership`:
 * `product_media` is keyed on (tenant, product, media), so the same
 * image twice is a duplicate-key 500. The FIRST occurrence wins, because
 * it is the one whose position the merchant chose — and position 0 is
 * the LCP image and the JSON-LD hero.
 */
async function writeGallery(
  tx: Tx,
  tenantId: string,
  productId: string,
  input: ProductMediaInput[],
): Promise<void> {
  // Built by hand rather than with a Map: keying a Map keeps the LAST
  // occurrence, and the first is the one whose position was chosen.
  const seen = new Set<string>();
  const items: ProductMediaInput[] = [];
  for (const item of input) {
    if (seen.has(item.mediaId)) continue;
    seen.add(item.mediaId);
    items.push(item);
  }

  await tx.delete(productMedia).where(eq(productMedia.productId, productId));

  if (items.length > 0) {
    await tx
      .insert(productMedia)
      .values(items.map((item, position) => ({ tenantId, productId, mediaId: item.mediaId, position })));
  }

  for (const item of items) {
    if (item.alt === null) continue;
    await tx
      .update(media)
      .set({ alt: item.alt, updatedAt: new Date() })
      .where(eq(media.id, item.mediaId));
  }
}

/** The ids a payload names, deduplicated, order preserved. */
function referencedMediaIds(input: ProductWriteInput): string[] {
  return [
    ...new Set([
      ...input.media.map((m) => m.mediaId),
      ...input.variants.flatMap((v) => (v.imageMediaId ? [v.imageMediaId] : [])),
    ]),
  ];
}

/** Compact enough to keep forever, complete enough to answer "what changed?". */
type ProductSnapshot = {
  title: string;
  slug: string | null;
  status: ProductStatus;
  variantCount: number;
  categoryIds: string[];
  collectionIds: string[];
};

// ───────────────────────────────────────────────────────────────
// Products
// ───────────────────────────────────────────────────────────────

export async function createProduct(
  ctx: WriteContext,
  input: ProductWriteInput,
): Promise<ProductWriteResult> {
  return withTenant(ctx.tenantId, async (tx) => {
    const issues = [
      ...matrixIssues(input),
      ...(await skuIssues(tx, ctx.tenantId, null, input.variants)),
    ];
    if (issues.length > 0) throw new CatalogValidationError(issues);

    await assertMediaVisible(tx, ctx.tenantId, referencedMediaIds(input));
    await assertTaxonomyVisible(tx, ctx.tenantId, input.categoryIds, input.collectionIds);

    const [product] = await tx
      .insert(products)
      .values({
        tenantId: ctx.tenantId,
        title: input.title,
        summary: input.summary,
        description: cleanDescription(input.description),
        status: input.status,
        productType: input.productType,
        vendor: input.vendor,
        tags: input.tags,
        hsnCode: input.hsnCode,
        taxRateBps: input.taxRateBps,
        seo: cleanSeo(input.seo),
        // Set on the first activation and never cleared. The storefront
        // orders listings by it, and PostgreSQL sorts NULLs FIRST under
        // DESC — so an active product without one jumps to the top of
        // every page and stays there.
        publishedAt: input.status === "active" ? new Date() : null,
        createdByUserId: ctx.actorUserId,
      })
      .returning({ id: products.id });

    if (!product) throw new Error("products insert returned no row");

    const { slug } = await setCanonicalSlug(
      tx,
      ctx.tenantId,
      "product",
      product.id,
      input.slug?.trim() || input.title,
    );

    await writeOptions(tx, ctx.tenantId, product.id, input.axes);
    await writeVariants(tx, ctx.tenantId, product.id, input.variants, ctx.actorUserId, true);
    await writeMembership(tx, ctx.tenantId, product.id, input.categoryIds, input.collectionIds);
    await writeGallery(tx, ctx.tenantId, product.id, input.media);

    await recordAudit(tx, ctx.tenantId, {
      actorType: "staff",
      actorUserId: ctx.actorUserId,
      action: "product.created",
      entityType: "product",
      entityId: product.id,
      after: snapshotOf(input, slug),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return { productId: product.id, slug, previousSlug: null };
  });
}

export async function updateProduct(
  ctx: WriteContext,
  productId: string,
  input: ProductWriteInput,
): Promise<ProductWriteResult> {
  return withTenant(ctx.tenantId, async (tx) => {
    // RLS is the tenancy check: another merchant's product is invisible
    // here, so it 404s rather than being editable. The explicit tenant
    // predicate is belt and braces on top — RLS failing open returns
    // zero rows rather than erroring, so a second statement of the same
    // fact is the difference between a silent "not found" and a leak if
    // anyone ever changes how this runs. The console READ path
    // (`getProductForConsole`) already writes it; this one should match.
    const [existing] = await tx
      .select({
        id: products.id,
        title: products.title,
        status: products.status,
        publishedAt: products.publishedAt,
      })
      .from(products)
      .where(
        and(
          eq(products.tenantId, ctx.tenantId),
          eq(products.id, productId),
          isNull(products.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) throw new ProductNotFoundError(productId);

    const issues = [
      ...matrixIssues(input),
      ...(await skuIssues(tx, ctx.tenantId, productId, input.variants)),
    ];
    if (issues.length > 0) throw new CatalogValidationError(issues);

    await assertMediaVisible(tx, ctx.tenantId, referencedMediaIds(input));
    await assertTaxonomyVisible(tx, ctx.tenantId, input.categoryIds, input.collectionIds);

    const before = await snapshotProduct(tx, ctx.tenantId, productId, existing.title, existing.status);

    await tx
      .update(products)
      .set({
        title: input.title,
        summary: input.summary,
        description: cleanDescription(input.description),
        status: input.status,
        productType: input.productType,
        vendor: input.vendor,
        tags: input.tags,
        hsnCode: input.hsnCode,
        taxRateBps: input.taxRateBps,
        seo: cleanSeo(input.seo),
        publishedAt:
          existing.publishedAt ?? (input.status === "active" ? new Date() : null),
        updatedAt: new Date(),
        updatedByUserId: ctx.actorUserId,
      })
      .where(eq(products.id, productId));

    const { slug, previous } = await setCanonicalSlug(
      tx,
      ctx.tenantId,
      "product",
      productId,
      input.slug?.trim() || input.title,
    );

    await writeOptions(tx, ctx.tenantId, productId, input.axes);
    await writeVariants(tx, ctx.tenantId, productId, input.variants, ctx.actorUserId, false);
    await writeMembership(tx, ctx.tenantId, productId, input.categoryIds, input.collectionIds);
    await writeGallery(tx, ctx.tenantId, productId, input.media);

    await recordAudit(tx, ctx.tenantId, {
      actorType: "staff",
      actorUserId: ctx.actorUserId,
      action: previous === null ? "product.updated" : "product.slug_changed",
      entityType: "product",
      entityId: productId,
      before,
      after: snapshotOf(input, slug),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return { productId, slug, previousSlug: previous };
  });
}

/*
 * There is deliberately no `deleteProduct`.
 *
 * `status = 'archived'` is how the catalog models removal, per the note
 * on PRODUCT_STATUSES: the row, its slugs, its order history and its
 * accumulated SEO all survive, and the storefront already hides it. A
 * hard delete cascades `url_slugs` away and turns a page that ranked
 * into a 404 with nothing left to redirect to.
 */

// ───────────────────────────────────────────────────────────────
// Categories and collections
// ───────────────────────────────────────────────────────────────

export type TaxonomyWriteInput = {
  title: string;
  slug?: string | null;
  description: string | null;
  /** Categories only; ignored for a collection, which is flat. */
  parentId?: string | null;
  position: number;
  isVisible: boolean;
  seo: ProductSeoInput;
};

export type TaxonomyWriteResult = { id: string; slug: string; previousSlug: string | null };

export async function createCategory(
  ctx: WriteContext,
  input: TaxonomyWriteInput,
): Promise<TaxonomyWriteResult> {
  return withTenant(ctx.tenantId, async (tx) => {
    if (input.parentId) await assertCategoryExists(tx, ctx.tenantId, input.parentId);

    const [row] = await tx
      .insert(categories)
      .values({
        tenantId: ctx.tenantId,
        title: input.title,
        description: cleanDescription(input.description),
        parentId: input.parentId ?? null,
        position: input.position,
        isVisible: input.isVisible,
        seo: cleanSeo(input.seo),
        createdByUserId: ctx.actorUserId,
      })
      .returning({ id: categories.id });

    if (!row) throw new Error("categories insert returned no row");

    const { slug } = await setCanonicalSlug(
      tx,
      ctx.tenantId,
      "category",
      row.id,
      input.slug?.trim() || input.title,
    );

    await recordAudit(tx, ctx.tenantId, {
      actorType: "staff",
      actorUserId: ctx.actorUserId,
      action: "category.created",
      entityType: "category",
      entityId: row.id,
      after: { title: input.title, slug, isVisible: input.isVisible },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return { id: row.id, slug, previousSlug: null };
  });
}

export async function updateCategory(
  ctx: WriteContext,
  categoryId: string,
  input: TaxonomyWriteInput,
): Promise<TaxonomyWriteResult> {
  return withTenant(ctx.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: categories.id, title: categories.title, isVisible: categories.isVisible })
      .from(categories)
      // The tenant predicate is redundant under RLS and written anyway.
      // A missing tenant context returns zero rows rather than erroring,
      // so if anyone ever changes how this runs the failure is a silent
      // "not found", not a crash. It also lets the planner use the
      // tenant-leading composite index.
      .where(
        and(
          eq(categories.tenantId, ctx.tenantId),
          eq(categories.id, categoryId),
          isNull(categories.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) throw new TaxonomyNotFoundError("category", categoryId);

    const parentId = await resolveParent(tx, ctx.tenantId, categoryId, input.parentId ?? null);

    await tx
      .update(categories)
      .set({
        title: input.title,
        description: cleanDescription(input.description),
        parentId,
        position: input.position,
        isVisible: input.isVisible,
        seo: cleanSeo(input.seo),
        updatedAt: new Date(),
        updatedByUserId: ctx.actorUserId,
      })
      .where(eq(categories.id, categoryId));

    const { slug, previous } = await setCanonicalSlug(
      tx,
      ctx.tenantId,
      "category",
      categoryId,
      input.slug?.trim() || input.title,
    );

    await recordAudit(tx, ctx.tenantId, {
      actorType: "staff",
      actorUserId: ctx.actorUserId,
      action: previous === null ? "category.updated" : "category.slug_changed",
      entityType: "category",
      entityId: categoryId,
      before: { title: existing.title, slug: previous, isVisible: existing.isVisible },
      after: { title: input.title, slug, isVisible: input.isVisible },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return { id: categoryId, slug, previousSlug: previous };
  });
}

export async function createCollection(
  ctx: WriteContext,
  input: TaxonomyWriteInput,
): Promise<TaxonomyWriteResult> {
  return withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(collections)
      .values({
        tenantId: ctx.tenantId,
        title: input.title,
        description: cleanDescription(input.description),
        position: input.position,
        isVisible: input.isVisible,
        seo: cleanSeo(input.seo),
        createdByUserId: ctx.actorUserId,
      })
      .returning({ id: collections.id });

    if (!row) throw new Error("collections insert returned no row");

    const { slug } = await setCanonicalSlug(
      tx,
      ctx.tenantId,
      "collection",
      row.id,
      input.slug?.trim() || input.title,
    );

    await recordAudit(tx, ctx.tenantId, {
      actorType: "staff",
      actorUserId: ctx.actorUserId,
      action: "collection.created",
      entityType: "collection",
      entityId: row.id,
      after: { title: input.title, slug, isVisible: input.isVisible },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return { id: row.id, slug, previousSlug: null };
  });
}

export async function updateCollection(
  ctx: WriteContext,
  collectionId: string,
  input: TaxonomyWriteInput,
): Promise<TaxonomyWriteResult> {
  return withTenant(ctx.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: collections.id, title: collections.title, isVisible: collections.isVisible })
      .from(collections)
      // Redundant under RLS, written anyway — see `updateCategory`.
      .where(
        and(
          eq(collections.tenantId, ctx.tenantId),
          eq(collections.id, collectionId),
          isNull(collections.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) throw new TaxonomyNotFoundError("collection", collectionId);

    await tx
      .update(collections)
      .set({
        title: input.title,
        description: cleanDescription(input.description),
        position: input.position,
        isVisible: input.isVisible,
        seo: cleanSeo(input.seo),
        updatedAt: new Date(),
        updatedByUserId: ctx.actorUserId,
      })
      .where(eq(collections.id, collectionId));

    const { slug, previous } = await setCanonicalSlug(
      tx,
      ctx.tenantId,
      "collection",
      collectionId,
      input.slug?.trim() || input.title,
    );

    await recordAudit(tx, ctx.tenantId, {
      actorType: "staff",
      actorUserId: ctx.actorUserId,
      action: previous === null ? "collection.updated" : "collection.slug_changed",
      entityType: "collection",
      entityId: collectionId,
      before: { title: existing.title, slug: previous, isVisible: existing.isVisible },
      after: { title: input.title, slug, isVisible: input.isVisible },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return { id: collectionId, slug, previousSlug: previous };
  });
}

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

async function assertCategoryExists(tx: Tx, tenantId: string, id: string): Promise<void> {
  const [row] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(eq(categories.tenantId, tenantId), eq(categories.id, id), isNull(categories.deletedAt)),
    )
    .limit(1);

  if (!row) {
    throw new CatalogValidationError([
      { path: "parentId", message: "That parent category does not exist in this store." },
    ]);
  }
}

/**
 * Validates a reparent, refusing anything that would detach a branch.
 *
 * The database CHECK only catches a category naming ITSELF as parent. A
 * two-step cycle (A under B, B under A) satisfies every constraint and
 * leaves both subtrees unreachable from any root — invisible in the
 * console and unfixable through the UI.
 *
 * The traversal itself is `isDescendant` from `./categories`, which is
 * pure, already carries unit tests for the cases that matter (including
 * termination on an existing cycle) and is what the storefront's
 * navigation uses. This function's job is only to fetch the nodes and
 * turn its boolean into the right error.
 */
async function resolveParent(
  tx: Tx,
  tenantId: string,
  categoryId: string,
  parentId: string | null,
): Promise<string | null> {
  if (!parentId) return null;
  await assertCategoryExists(tx, tenantId, parentId);

  const all = await tx
    .select({ id: categories.id, parentId: categories.parentId, title: categories.title, position: categories.position })
    .from(categories)
    .where(and(eq(categories.tenantId, tenantId), isNull(categories.deletedAt)));

  if (isDescendant(all, categoryId, parentId)) {
    throw new CatalogValidationError([
      { path: "parentId", message: "A category cannot be filed under itself or its own child." },
    ]);
  }

  return parentId;
}

/** Sanitised, and collapsed to null when nothing survives. */
function cleanDescription(raw: string | null): string | null {
  if (raw === null) return null;
  return sanitizeDescriptionHtml(raw) || null;
}

/** Only the three keys the storefront reads, so no junk accumulates. */
function cleanSeo(seo: ProductSeoInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (seo.title?.trim()) out.title = seo.title.trim();
  if (seo.description?.trim()) out.description = seo.description.trim();
  if (seo.noindex) out.noindex = true;
  return out;
}

function snapshotOf(input: ProductWriteInput, slug: string): ProductSnapshot {
  return {
    title: input.title,
    slug,
    status: input.status,
    variantCount: input.variants.length,
    categoryIds: input.categoryIds,
    collectionIds: input.collectionIds,
  };
}

async function snapshotProduct(
  tx: Tx,
  tenantId: string,
  productId: string,
  title: string,
  status: ProductStatus,
): Promise<ProductSnapshot> {
  const [slugRow] = await tx
    .select({ slug: urlSlugs.slug })
    .from(urlSlugs)
    .where(
      and(
        eq(urlSlugs.tenantId, tenantId),
        eq(urlSlugs.entityType, "product"),
        eq(urlSlugs.entityId, productId),
        eq(urlSlugs.isCanonical, true),
      ),
    )
    .limit(1);

  const [variants, categoryRows, collectionRows] = await Promise.all([
    tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt))),
    tx
      .select({ id: productCategories.categoryId })
      .from(productCategories)
      .where(eq(productCategories.productId, productId)),
    tx
      .select({ id: productCollections.collectionId })
      .from(productCollections)
      .where(eq(productCollections.productId, productId)),
  ]);

  return {
    title,
    slug: slugRow?.slug ?? null,
    status,
    variantCount: variants.length,
    categoryIds: categoryRows.map((r) => r.id),
    collectionIds: collectionRows.map((r) => r.id),
  };
}
