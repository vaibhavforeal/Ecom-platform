import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import {
  MEDIA_STATUSES,
  PRODUCT_STATUSES,
  SLUG_ENTITY_TYPES,
  sqlLiteralList,
} from "./enums";
import type { MediaStatus, ProductStatus, SlugEntityType } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";

/**
 * DATA PLANE — RLS-protected (see store.ts).
 *
 * The catalog. Every table here carries tenant_id and is therefore given
 * FORCE ROW LEVEL SECURITY plus a tenant_isolation policy automatically
 * by src/rls.ts — nothing below needs to remember to filter by tenant.
 *
 * See PLATFORM_BLUEPRINT.md §3.2.
 */

/**
 * Postgres full-text search vectors.
 *
 * Not a Drizzle built-in, so it is declared here rather than reached for
 * with raw SQL at each call site — the search column needs a real type
 * for `drizzle-kit generate` to emit correct DDL.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

/**
 * The text search configuration the product index is built with.
 *
 * Exported because queries MUST parse with the same configuration.
 * Searching an 'english' vector with 'simple' loses stemming — "shirts"
 * stops finding "shirt" — and nothing errors, so the store just quietly
 * returns fewer results than it should. @platform/core imports this
 * rather than repeating the string.
 *
 * Changing it rewrites every product's search_vector, so it is a
 * migration, which is exactly what it should be.
 */
export const SEARCH_TEXT_CONFIG = "english";

/** Money columns carry their currency explicitly (blueprint §3.1). */
const currency = () => char("currency", { length: 3 }).notNull().default("INR");

/**
 * Money. BIGINT paise, never float, never INT (blueprint §3.1).
 *
 * INT tops out around ₹21.4 million, which a single order of jewellery
 * or machinery clears — and it overflows at the *sum*, not the item, so
 * the first failure is an aggregate report rather than a rejected write.
 * `mode: "number"` keeps it a JS number, exact to ₹90 trillion.
 */
const paise = (name: string) => bigint(name, { mode: "number" });

// ───────────────────────────────────────────────────────────────
// Media
// ───────────────────────────────────────────────────────────────

/**
 * An uploaded asset and its generated derivatives.
 *
 * `storageKey` is the object-storage path of the ORIGINAL. Derivatives
 * (AVIF/WebP at each breakpoint) are recorded in `derivatives` rather
 * than as rows, because they are an implementation detail of the render
 * pipeline: regenerating the whole set at new breakpoints should be one
 * job writing one column, not a fan-out of row deletes.
 *
 * `width`/`height` are stored so the storefront can emit explicit
 * dimensions on every <img>. That is not a nicety — layout shift from
 * unsized images is the single easiest way to fail the CLS budget in
 * blueprint §6.2, and it cannot be fixed in CSS after the fact.
 */
export const media = pgTable(
  "media",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),

    /** Merchant-authored alt text. Accessibility and image SEO. */
    alt: text("alt"),

    /**
     * SHA-256 of the original bytes. Lets a re-upload of the same file
     * reuse the existing derivatives instead of paying to process it
     * again — merchants re-upload the same images constantly.
     */
    checksum: text("checksum"),

    status: text("status").$type<MediaStatus>().notNull().default("pending"),
    /** [{ format, width, height, storageKey, byteSize }] */
    derivatives: jsonb("derivatives").notNull().default(sql`'[]'::jsonb`),
    processingError: text("processing_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("media_tenant_storage_key_key").on(t.tenantId, t.storageKey),
    index("media_tenant_checksum_idx").on(t.tenantId, t.checksum),
    index("media_status_idx").on(t.status),
    check("media_status_check", sql`${t.status} IN (${sql.raw(sqlLiteralList(MEDIA_STATUSES))})`),
    check("media_byte_size_check", sql`${t.byteSize} >= 0`),
  ],
);

// ───────────────────────────────────────────────────────────────
// Taxonomy: categories (a tree) and collections (curated, flat)
// ───────────────────────────────────────────────────────────────

/**
 * The browsable taxonomy. A tree, one parent per node.
 *
 * Kept separate from collections on purpose. A category is where a
 * product *belongs* and drives breadcrumbs and the JSON-LD
 * `BreadcrumbList`; a collection is a merchandising grouping a product
 * may be in many of ("Diwali Sale"). Conflating them means either a
 * product with three breadcrumb trails or a sale you cannot model.
 */
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    parentId: uuid("parent_id"),
    title: text("title").notNull(),
    description: text("description"),
    imageMediaId: uuid("image_media_id").references(() => media.id, { onDelete: "set null" }),

    /** Manual ordering within the parent. */
    position: integer("position").notNull().default(0),
    isVisible: boolean("is_visible").notNull().default(true),

    /** { title, description, noindex } — overrides the generated defaults. */
    seo: jsonb("seo").notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("categories_tenant_parent_idx").on(t.tenantId, t.parentId, t.position),
    // Self-reference, declared here because the column cannot reference
    // a table that is still being defined.
    foreignKey({
      columns: [t.parentId],
      foreignColumns: [t.id],
      name: "categories_parent_id_fk",
    }).onDelete("set null"),
    // A category cannot be its own parent. Deeper cycles are caught in
    // core — a CHECK cannot see the rest of the tree.
    check("categories_parent_not_self_check", sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
  ],
);

/** Curated grouping. Flat, and a product may be in many. */
export const collections = pgTable(
  "collections",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    title: text("title").notNull(),
    description: text("description"),
    imageMediaId: uuid("image_media_id").references(() => media.id, { onDelete: "set null" }),

    position: integer("position").notNull().default(0),
    isVisible: boolean("is_visible").notNull().default(true),
    seo: jsonb("seo").notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("collections_tenant_visible_idx").on(t.tenantId, t.isVisible, t.position)],
);

// ───────────────────────────────────────────────────────────────
// Products
// ───────────────────────────────────────────────────────────────

/**
 * The sellable thing, as the customer thinks of it. Price and stock live
 * on variants, never here — even a product with no options gets exactly
 * one variant, so nothing downstream (cart, invoice, POS scan, courier
 * weight) ever needs a "does this have variants?" branch.
 *
 * `hsnCode` and `taxRateBps` sit at product level because GST
 * classification is a property of the goods, not of the size you picked.
 */
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    title: text("title").notNull(),
    /** Long-form, merchant-authored. Rendered as sanitised HTML. */
    description: text("description"),
    /** Short summary for cards, meta description fallback, WhatsApp shares. */
    summary: text("summary"),

    status: text("status").$type<ProductStatus>().notNull().default("draft"),
    /** Free-text merchandising fields merchants filter and facet on. */
    productType: text("product_type"),
    vendor: text("vendor"),
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),

    // GST classification (blueprint §4.1). Nullable because an
    // unregistered merchant has nothing to declare yet, and blocking
    // catalog entry on a tax field they do not have is how onboarding dies.
    hsnCode: text("hsn_code"),
    taxRateBps: integer("tax_rate_bps"),

    seo: jsonb("seo").notNull().default(sql`'{}'::jsonb`),

    /**
     * Search index, maintained by Postgres rather than by the
     * application. A trigger or an application-side UPDATE drifts the
     * first time a row is written by a path that forgot about it —
     * a CSV import, a backfill script, psql. A generated column cannot.
     *
     * Title outranks summary outranks description via setweight, so an
     * exact title match beats an incidental mention in body copy.
     */
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('${sql.raw(SEARCH_TEXT_CONFIG)}', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('${sql.raw(SEARCH_TEXT_CONFIG)}', coalesce(summary, '')), 'B') ||
          setweight(to_tsvector('${sql.raw(SEARCH_TEXT_CONFIG)}', coalesce(description, '')), 'C')`,
    ),

    publishedAt: timestamp("published_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("products_tenant_status_idx").on(t.tenantId, t.status, t.publishedAt),
    index("products_tenant_updated_idx").on(t.tenantId, t.updatedAt),
    index("products_search_idx").using("gin", t.searchVector),
    index("products_tags_idx").using("gin", t.tags),
    check("products_status_check", sql`${t.status} IN (${sql.raw(sqlLiteralList(PRODUCT_STATUSES))})`),
    check(
      "products_tax_rate_check",
      sql`${t.taxRateBps} IS NULL OR (${t.taxRateBps} >= 0 AND ${t.taxRateBps} <= 10000)`,
    ),
  ],
);

/**
 * A variant axis — "Size", "Colour". Declares the shape of the option
 * matrix; the values a given variant sits at are on the variant itself.
 */
export const productOptions = pgTable(
  "product_options",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),

    name: text("name").notNull(), // 'Size'
    position: integer("position").notNull().default(0),
  },
  (t) => [
    uniqueIndex("product_options_product_name_key").on(t.tenantId, t.productId, t.name),
    index("product_options_product_idx").on(t.tenantId, t.productId, t.position),
  ],
);

/**
 * A permitted value on an axis — "M", "Red".
 *
 * Stored as rows rather than an array so the PDP selector can render
 * every possible value in the merchant's chosen order, including ones
 * with no variant behind them (which is what lets the UI grey out
 * "Size: XL — sold out" instead of silently hiding it).
 */
export const productOptionValues = pgTable(
  "product_option_values",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => productOptions.id, { onDelete: "cascade" }),

    value: text("value").notNull(), // 'M'
    position: integer("position").notNull().default(0),
  },
  (t) => [
    uniqueIndex("product_option_values_key").on(t.tenantId, t.optionId, t.value),
    index("product_option_values_option_idx").on(t.tenantId, t.optionId, t.position),
  ],
);

/**
 * The actually-sellable unit: what carries a SKU, a price and a weight.
 *
 * `options` is a flat map — { "Size": "M", "Colour": "Red" } — matching
 * blueprint §3.2. Validation that it names exactly the product's
 * declared axes lives in @platform/core, where it can see the whole
 * product; the unique index below only stops two variants claiming the
 * same combination.
 *
 * `weightGrams` is NOT NULL with no default on purpose. Every courier
 * rate in Phase 3 is computed from billable weight, and a variant that
 * silently weighed 0 would quote shipping at zero and be discovered at
 * the first weight-dispute invoice.
 */
export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").primaryKey().$defaultFn(uuidv7),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),

    sku: text("sku").notNull(),
    barcode: text("barcode"), // EAN/UPC — POS scanning in Phase 5
    options: jsonb("options").notNull().default(sql`'{}'::jsonb`),

    pricePaise: paise("price_paise").notNull(),
    compareAtPaise: paise("compare_at_paise"),
    /** Merchant's landed cost. Never exposed to the storefront. */
    costPaise: paise("cost_paise"),
    currency: currency(),

    weightGrams: integer("weight_grams").notNull(),
    /** { l, w, h } in mm — volumetric weight for courier rating. */
    dimsMm: jsonb("dims_mm"),

    lowStockAt: integer("low_stock_at").default(2),
    imageMediaId: uuid("image_media_id").references(() => media.id, { onDelete: "set null" }),

    position: integer("position").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // Partial so a deleted variant's SKU can be reused. Merchants delete
    // a variant and re-add it under the same code constantly, and a hard
    // unique index turns that into a support ticket.
    uniqueIndex("product_variants_tenant_sku_key")
      .on(t.tenantId, t.sku)
      .where(sql`deleted_at IS NULL`),
    uniqueIndex("product_variants_option_combo_key")
      .on(t.tenantId, t.productId, t.options)
      .where(sql`deleted_at IS NULL`),
    index("product_variants_product_idx").on(t.tenantId, t.productId, t.position),
    index("product_variants_barcode_idx").on(t.tenantId, t.barcode),
    // Money is non-negative; a negative price is always a bug, and one
    // that pays the customer.
    check("product_variants_price_check", sql`${t.pricePaise} >= 0`),
    check(
      "product_variants_compare_at_check",
      sql`${t.compareAtPaise} IS NULL OR ${t.compareAtPaise} >= 0`,
    ),
    check("product_variants_weight_check", sql`${t.weightGrams} >= 0`),
  ],
);

// ───────────────────────────────────────────────────────────────
// Joins
// ───────────────────────────────────────────────────────────────

export const productCategories = pgTable(
  "product_categories",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.productId, t.categoryId] }),
    index("product_categories_category_idx").on(t.tenantId, t.categoryId, t.position),
  ],
);

export const productCollections = pgTable(
  "product_collections",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.productId, t.collectionId] }),
    index("product_collections_collection_idx").on(t.tenantId, t.collectionId, t.position),
  ],
);

/** Gallery order. Position 0 is the LCP image and the JSON-LD hero. */
export const productMedia = pgTable(
  "product_media",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.productId, t.mediaId] }),
    index("product_media_product_idx").on(t.tenantId, t.productId, t.position),
  ],
);

// ───────────────────────────────────────────────────────────────
// URLs
// ───────────────────────────────────────────────────────────────

/**
 * Every public URL the tenant has ever served, current and historical.
 *
 * Renaming a product must not break its inbound links. The old slug
 * stays here with `isCanonical = false` and the storefront 301s it to
 * whichever slug is canonical now. Without these rows, a merchant fixing
 * a typo in a title silently 404s a page that took months to rank —
 * which is why this is a table from day one and not a Phase 6 concern.
 *
 * Keyed per tenant across all entity types, so a product and a category
 * can never claim the same path.
 */
export const urlSlugs = pgTable(
  "url_slugs",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),

    entityType: text("entity_type").$type<SlugEntityType>().notNull(),
    entityId: uuid("entity_id").notNull(),

    isCanonical: boolean("is_canonical").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.slug] }),
    // Exactly one canonical slug per entity. A second one would make the
    // canonical tag non-deterministic and split the page's ranking.
    uniqueIndex("url_slugs_one_canonical_key")
      .on(t.tenantId, t.entityType, t.entityId)
      .where(sql`is_canonical`),
    index("url_slugs_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    check(
      "url_slugs_entity_type_check",
      sql`${t.entityType} IN (${sql.raw(sqlLiteralList(SLUG_ENTITY_TYPES))})`,
    ),
  ],
);
