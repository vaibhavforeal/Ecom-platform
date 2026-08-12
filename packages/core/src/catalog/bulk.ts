import { and, eq, isNull, products, urlSlugs, withTenant } from "@platform/db";
import type { ProductStatus, Tx } from "@platform/db";

import { MAX_IMPORT_ROWS, catalogCsvHeader, parseCatalogCsv, productToCsvRows } from "./csv";
import type {
  CsvIssue,
  CsvProductDraft,
  CsvProductStatus,
  CsvVariantDraft,
  ImportProductResult,
  ImportReport,
} from "./csv";
import { EXPORT_PAGE_SIZE, getProductForConsoleInTx, listProductsForExport } from "./console-queries";
import type { ConsoleProduct, ConsoleVariant } from "./console-queries";
import { optionKey } from "./options";
import type { OptionAxis, OptionSelection } from "./options";
import { slugify } from "./slug";
import {
  CatalogValidationError,
  cleanDescription,
  cleanSeo,
  createProductInTx,
  updateProductInTx,
} from "./writes";
import type { ProductWriteInput, VariantInput, WriteContext } from "./writes";

/**
 * Bulk catalog import and export. SERVER ONLY.
 *
 * `./csv` does the reading and writing of the format; this file is the
 * part that touches the database. Four rules shape all of it:
 *
 *  1. **One transaction for the whole file.** A failure on row 300 that
 *     leaves rows 1–299 committed is half a catalog, and a merchant
 *     cannot tell which half. Every product goes through the write
 *     layer's `…InTx` entry points inside a single `withTenant`.
 *
 *  2. **Dry run is the default,** and it is the same code path — the
 *     transaction is rolled back at the end rather than skipped, so the
 *     preview a merchant approves is a report of writes that actually
 *     succeeded, unique indexes and all.
 *
 *  3. **Absent is not empty.** A column missing from the file leaves the
 *     stored value alone; a variant missing from the file is KEPT. An
 *     importer that treats omission as deletion turns a merchant's
 *     five-column price update into a catalog wipe, and the damage is
 *     only visible once the storefront is empty.
 *
 *  4. **The tenant comes from the session.** It is a field of
 *     `WriteContext` and there is no other way in. A `tenant_id` column
 *     in the CSV is an unrecognised header, which the parser ignores.
 */

/**
 * The CSV's status list and the database's must stay in step.
 *
 * `csv.ts` writes its own list rather than importing `PRODUCT_STATUSES`,
 * because `@platform/db` drags the postgres driver into any bundle that
 * touches it and `csv.ts` is client-safe. This record is the one place
 * both lists are named, so a status added or renamed in the database
 * without a matching change over there fails to compile here.
 */
const STATUS_PARITY: Record<ProductStatus, CsvProductStatus> = {
  draft: "draft",
  active: "active",
  archived: "archived",
};

/** Thrown to unwind a dry run's transaction. Never escapes this file. */
class DryRunRollback extends Error {
  readonly report: ImportReport;

  constructor(report: ImportReport) {
    super("dry run");
    this.name = "DryRunRollback";
    this.report = report;
  }
}

/** The write layer refused a product; the file is rejected as a whole. */
class ImportRejected extends Error {
  readonly issues: CsvIssue[];

  constructor(issues: CsvIssue[]) {
    super("import rejected");
    this.name = "ImportRejected";
    this.issues = issues;
  }
}

// ───────────────────────────────────────────────────────────────
// Import
// ───────────────────────────────────────────────────────────────

export type ImportOptions = {
  /** Nothing is written unless this is explicitly true. */
  commit?: boolean;
};

/**
 * Reads a parsed CSV into the catalog, or tells the merchant why it will
 * not.
 *
 * Errors are collected before anything is written and, if there are any,
 * the database is not touched at all: a report saying "142 rows fine,
 * three broken" alongside 142 committed products would leave the
 * merchant guessing which of their fixes still needs applying.
 */
export async function runCatalogImport(
  ctx: WriteContext,
  records: string[][],
  opts: ImportOptions = {},
): Promise<ImportReport> {
  const parsed = parseCatalogCsv(records);

  if (parsed.rowCount > MAX_IMPORT_ROWS) {
    parsed.issues.push({
      row: 1,
      column: null,
      message: `This file has ${parsed.rowCount} rows; ${MAX_IMPORT_ROWS} is the most one import can take.`,
    });
  }

  if (parsed.issues.length > 0) return rejected(parsed.issues, parsed.rowCount);

  try {
    return await withTenant(ctx.tenantId, async (tx) => {
      const results: ImportProductResult[] = [];

      for (const draft of parsed.products) {
        results.push(await applyProduct(tx, ctx, draft));
      }

      const report = summarise(results, parsed.rowCount, opts.commit === true);

      // The dry run does every write and then throws it all away, so
      // what the merchant approves is a preview of writes that really
      // happened — SKU collisions, matrix errors and unique indexes
      // included — rather than of writes we believe would happen.
      if (opts.commit !== true) throw new DryRunRollback(report);

      return report;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.report;
    if (err instanceof ImportRejected) return rejected(err.issues, parsed.rowCount);
    throw err;
  }
}

function rejected(issues: CsvIssue[], rows: number): ImportReport {
  return {
    committed: false,
    rows,
    created: 0,
    updated: 0,
    skipped: 0,
    errored: new Set(issues.map((i) => i.row)).size,
    issues,
    results: [],
  };
}

function summarise(
  results: ImportProductResult[],
  rows: number,
  committed: boolean,
): ImportReport {
  return {
    committed,
    rows,
    created: results.filter((r) => r.outcome === "created").length,
    updated: results.filter((r) => r.outcome === "updated").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    errored: 0,
    issues: [],
    // A dry run inserts a new product and then rolls the transaction
    // back, so the id it saw is about to stop existing. Handing it to
    // the console would give the merchant a link that 404s.
    results: committed
      ? results
      : results.map((r) => (r.outcome === "created" ? { ...r, productId: null } : r)),
  };
}

/**
 * One product: match it, merge the file over what is stored, and write
 * only if that changed something.
 */
async function applyProduct(
  tx: Tx,
  ctx: WriteContext,
  draft: CsvProductDraft,
): Promise<ImportProductResult> {
  const existing = await findByHandle(tx, ctx.tenantId, draft.handle);
  const merged = mergeProduct(draft, existing);

  // Unreachable while `title` is a required column — a file without one
  // is rejected before the transaction opens. Stated anyway, because the
  // alternative to this branch is a product created with no name.
  if (merged.input.title === "") {
    throw new ImportRejected([
      { row: draft.row, column: "title", message: "A new product needs a title." },
    ]);
  }

  const retained = existing
    ? existing.variants.filter((v) => !draft.variants.some((d) => d.sku === v.sku)).length
    : 0;

  if (existing && !isChanged(merged.input, existing)) {
    return {
      handle: draft.handle,
      row: draft.row,
      outcome: "skipped",
      productId: existing.id,
      slug: existing.slug,
      variantsWritten: draft.variants.length,
      variantsRetained: retained,
    };
  }

  try {
    const result = existing
      ? await updateProductInTx(tx, ctx, existing.id, merged.input)
      : await createProductInTx(tx, ctx, merged.input);

    return {
      handle: draft.handle,
      row: draft.row,
      outcome: existing ? "updated" : "created",
      productId: result.productId,
      slug: result.slug,
      variantsWritten: draft.variants.length,
      variantsRetained: retained,
    };
  } catch (err) {
    // The write layer speaks in payload paths (`variants.2.sku`). The
    // merchant is looking at a spreadsheet, so those become the row and
    // column they can actually navigate to.
    if (err instanceof CatalogValidationError) {
      throw new ImportRejected(mapWriteIssues(err, draft, merged.variantRows));
    }
    throw err;
  }
}

/**
 * The product this handle names, or null.
 *
 * Matched on the CANONICAL slug only. A superseded slug still belongs to
 * its product and still redirects, but treating it as a match would let
 * a merchant re-importing last month's file silently rename a product
 * back — undoing a URL change they made deliberately.
 */
async function findByHandle(
  tx: Tx,
  tenantId: string,
  handle: string,
): Promise<ConsoleProduct | null> {
  const [row] = await tx
    .select({ entityId: urlSlugs.entityId })
    .from(urlSlugs)
    .where(
      and(
        eq(urlSlugs.tenantId, tenantId),
        eq(urlSlugs.entityType, "product"),
        eq(urlSlugs.slug, handle),
        eq(urlSlugs.isCanonical, true),
      ),
    )
    .limit(1);

  if (!row) return null;

  // The slug row can outlive a soft-deleted product; that is not a match.
  const [live] = await tx
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.tenantId, tenantId),
        eq(products.id, row.entityId),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);

  if (!live) return null;

  return getProductForConsoleInTx(tx, tenantId, row.entityId);
}

// ───────────────────────────────────────────────────────────────
// Merging the file over what is stored
// ───────────────────────────────────────────────────────────────

type Merged = {
  input: ProductWriteInput;
  /** Row number per variant of `input.variants`; null for a retained one. */
  variantRows: (number | null)[];
};

/**
 * The file's cells over the stored product.
 *
 * `undefined` on a draft field means the column was not in the file, and
 * the stored value survives. `null` means the column was there and blank,
 * which clears the field. Everything the CSV has no column for at all —
 * categories, collections, the image gallery, a variant's own image — is
 * copied across untouched, because a spreadsheet cannot express them and
 * an import that dropped them would be destroying data the merchant
 * never mentioned.
 */
function mergeProduct(draft: CsvProductDraft, existing: ConsoleProduct | null): Merged {
  const variantRows: (number | null)[] = [];
  const variants: VariantInput[] = [];

  const byExistingSku = new Map((existing?.variants ?? []).map((v) => [v.sku, v]));
  const named = new Set(draft.variants.map((v) => v.sku));

  for (const row of draft.variants) {
    variants.push(mergeVariant(row, byExistingSku.get(row.sku) ?? null));
    variantRows.push(row.row);
  }

  /**
   * Variants the file does not mention are KEPT, appended after the ones
   * it does. Deleting them would be destruction by omission: a merchant
   * correcting three prices in a spreadsheet has not asked for the other
   * forty variants of that product to disappear, and the loss would only
   * show up when a customer could no longer buy a size.
   */
  for (const v of existing?.variants ?? []) {
    if (named.has(v.sku)) continue;
    variants.push(retainVariant(v));
    variantRows.push(null);
  }

  const storedSeo = seoOf(existing?.seo ?? {});
  const seo = {
    title: pick(draft.seoTitle, storedSeo.title),
    description: pick(draft.seoDescription, storedSeo.description),
    noindex: draft.seoNoindex ?? storedSeo.noindex,
  };

  const input: ProductWriteInput = {
    title: draft.title || existing?.title || "",
    // The handle IS the URL. Passing it explicitly on an update means a
    // title change in the file does NOT silently move the product's page.
    slug: draft.handle,
    summary: pick(draft.summary, existing?.summary ?? null),
    description: pick(draft.description, existing?.description ?? null),
    status: draft.status ?? existing?.status ?? "draft",
    productType: pick(draft.productType, existing?.productType ?? null),
    vendor: pick(draft.vendor, existing?.vendor ?? null),
    tags: draft.tags ?? existing?.tags ?? [],
    hsnCode: pick(draft.hsnCode, existing?.hsnCode ?? null),
    taxRateBps: draft.taxRateBps === undefined ? (existing?.taxRateBps ?? null) : draft.taxRateBps,
    seo,
    axes: mergeAxes(draft, existing, variants),
    variants,
    categoryIds: existing?.categoryIds ?? [],
    collectionIds: existing?.collectionIds ?? [],
    // `alt` null leaves each image's existing text alone.
    media: (existing?.media ?? []).map((m) => ({ mediaId: m.id, alt: null })),
  };

  return { input, variantRows };
}

function pick<T>(fromFile: T | null | undefined, stored: T | null): T | null {
  return fromFile === undefined ? stored : fromFile;
}

function mergeVariant(row: CsvVariantDraft, existing: ConsoleVariant | null): VariantInput {
  return {
    id: existing?.id ?? null,
    sku: row.sku,
    barcode: pick(row.barcode, existing?.barcode ?? null),
    // No option columns in the file at all: the stored matrix position
    // stands. A five-column price update must not flatten every variant
    // of a product onto the same (empty) combination.
    options: row.options ?? existing?.options ?? {},
    pricePaise: row.pricePaise,
    compareAtPaise: pick(row.compareAtPaise, existing?.compareAtPaise ?? null),
    costPaise: pick(row.costPaise, existing?.costPaise ?? null),
    weightGrams: row.weightGrams,
    lowStockAt: pick(row.lowStockAt, existing?.lowStockAt ?? null),
    imageMediaId: existing?.imageMediaId ?? null,
    isActive: row.isActive ?? existing?.isActive ?? true,
  };
}

function retainVariant(v: ConsoleVariant): VariantInput {
  return {
    id: v.id,
    sku: v.sku,
    barcode: v.barcode,
    options: v.options,
    pricePaise: v.pricePaise,
    compareAtPaise: v.compareAtPaise,
    costPaise: v.costPaise,
    weightGrams: v.weightGrams,
    lowStockAt: v.lowStockAt,
    imageMediaId: v.imageMediaId,
    isActive: v.isActive,
  };
}

/**
 * The option axes, grown but never pruned.
 *
 * Stored axes and their values come first, in their stored order, and
 * anything the file introduces is appended. Two reasons it works this
 * way rather than rebuilding from the file:
 *
 *  · An axis value with no variant behind it is legal — a merchant can
 *    declare Size S/M/L and stock only S and M. Rebuilding from the
 *    file's rows would silently drop L, so a re-imported export would
 *    not be a no-op.
 *  · Retained variants still have to satisfy the matrix. An axis that
 *    lost the value one of them sits at would fail validation for a
 *    variant the merchant never touched.
 *
 * Removing an option value is therefore a console operation, not a CSV
 * one. That asymmetry is deliberate: nothing destructive should be
 * reachable by leaving a cell blank.
 */
function mergeAxes(
  draft: CsvProductDraft,
  existing: ConsoleProduct | null,
  variants: VariantInput[],
): OptionAxis[] {
  const axes: OptionAxis[] = (existing?.axes ?? []).map((a) => ({
    name: a.name,
    values: [...a.values],
  }));

  for (const name of draft.optionNames ?? []) {
    if (!axes.some((a) => a.name === name)) axes.push({ name, values: [] });
  }

  for (const variant of variants) {
    for (const [name, value] of Object.entries(variant.options)) {
      const axis = axes.find((a) => a.name === name);
      if (!axis) continue; // reported by the write layer as an unknown axis
      if (!axis.values.includes(value)) axis.values.push(value);
    }
  }

  return axes;
}

// ───────────────────────────────────────────────────────────────
// "Is this actually a change?"
// ───────────────────────────────────────────────────────────────

/**
 * Whether writing `input` would alter anything already stored.
 *
 * This is what makes "export, re-import unchanged" a genuine no-op
 * rather than an idempotent rewrite. Calling the write layer anyway
 * would produce identical columns, but it would also bump `updated_at`,
 * stamp a new `updated_by_user_id`, soft-delete and revive every variant
 * row, and file an audit entry per product — so a merchant who exported
 * their catalog to look at it would find their entire audit log
 * rewritten by opening a spreadsheet.
 *
 * Comparison is against what would be STORED, not against the raw input:
 * the description goes through the same sanitiser the write layer uses,
 * and the SEO object through the same three-key filter, or a re-import
 * of an already-sanitised description would read as an edit forever.
 */
function isChanged(input: ProductWriteInput, existing: ConsoleProduct): boolean {
  if (input.title !== existing.title) return true;
  if (slugify(input.slug ?? input.title, { fallback: "item" }) !== existing.slug) return true;
  if (input.summary !== existing.summary) return true;
  if (cleanDescription(input.description) !== existing.description) return true;
  if (input.status !== existing.status) return true;
  if (input.productType !== existing.productType) return true;
  if (input.vendor !== existing.vendor) return true;
  if (input.hsnCode !== existing.hsnCode) return true;
  if (input.taxRateBps !== existing.taxRateBps) return true;
  if (!sameStrings(input.tags, existing.tags)) return true;
  if (
    JSON.stringify(cleanSeo(input.seo)) !== JSON.stringify(cleanSeo(seoOf(existing.seo)))
  ) {
    return true;
  }
  if (!sameAxes(input.axes, existing.axes)) return true;

  if (input.variants.length !== existing.variants.length) return true;
  for (const [i, variant] of input.variants.entries()) {
    // Position is written from array order, so index-for-index.
    const stored = existing.variants[i];
    if (!stored) return true;
    if (
      variant.sku !== stored.sku ||
      variant.barcode !== stored.barcode ||
      optionKey(variant.options) !== optionKey(stored.options) ||
      variant.pricePaise !== stored.pricePaise ||
      variant.compareAtPaise !== stored.compareAtPaise ||
      variant.costPaise !== stored.costPaise ||
      variant.weightGrams !== stored.weightGrams ||
      variant.lowStockAt !== stored.lowStockAt ||
      variant.imageMediaId !== stored.imageMediaId ||
      variant.isActive !== stored.isActive
    ) {
      return true;
    }
  }

  // Categories, collections and the gallery are copied from `existing`
  // wholesale in `mergeProduct`, so there is nothing here to compare.
  return false;
}

/**
 * The stored `seo` jsonb, narrowed to the three keys anything reads.
 *
 * It is `Record<string, unknown>` on the way out of the database and a
 * merchant's own object on the way in, so nothing may assume a shape:
 * a value that is not a string is treated as absent rather than
 * stringified into a meta tag.
 */
function seoOf(stored: Record<string, unknown>): {
  title: string | null;
  description: string | null;
  noindex: boolean;
} {
  return {
    title: typeof stored.title === "string" ? stored.title : null,
    description: typeof stored.description === "string" ? stored.description : null,
    noindex: stored.noindex === true,
  };
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameAxes(a: OptionAxis[], b: OptionAxis[]): boolean {
  return (
    a.length === b.length &&
    a.every((axis, i) => {
      const other = b[i];
      return other !== undefined && axis.name === other.name && sameStrings(axis.values, other.values);
    })
  );
}

// ───────────────────────────────────────────────────────────────
// Write-layer issues → spreadsheet coordinates
// ───────────────────────────────────────────────────────────────

const VARIANT_PATH = /^variants\.(\d+)(?:\.(\w+))?$/;

/** Column names the write layer's payload paths map onto. */
const PATH_COLUMNS: Record<string, string> = {
  sku: "sku",
  slug: "handle",
  axes: "option1_name",
  categoryIds: "handle",
  collectionIds: "handle",
  media: "handle",
};

function mapWriteIssues(
  err: CatalogValidationError,
  draft: CsvProductDraft,
  variantRows: (number | null)[],
): CsvIssue[] {
  const issues = (err.details as { issues?: { path: string; message: string }[] } | undefined)
    ?.issues;
  if (!issues || issues.length === 0) {
    return [{ row: draft.row, column: null, message: err.publicMessage }];
  }

  return issues.map(({ path, message }) => {
    const match = VARIANT_PATH.exec(path);
    if (match) {
      const index = Number(match[1]);
      // A retained variant has no row in the file. Reporting it against
      // the product's first row is the honest answer: the merchant did
      // not write the offending line, but that is where they have to
      // look to understand it.
      const row = variantRows[index] ?? draft.row;
      return { row, column: PATH_COLUMNS[match[2] ?? ""] ?? null, message };
    }
    return { row: draft.row, column: PATH_COLUMNS[path] ?? null, message };
  });
}

// ───────────────────────────────────────────────────────────────
// Export
// ───────────────────────────────────────────────────────────────

/**
 * The whole catalog as CSV, a page at a time.
 *
 * A generator rather than a string: a few thousand products is several
 * megabytes, and the route pipes these chunks straight into the response
 * so neither the server nor the merchant waits for the last page before
 * the first byte moves. Each page is its own short transaction — holding
 * one open across the whole download would pin a connection for as long
 * as the merchant's network takes.
 *
 * Two kinds of product are skipped, both because the format cannot
 * carry them and re-importing the result would make things worse:
 *
 *  · No canonical slug. `handle` is what an import matches on, so a row
 *    without one could only ever create a duplicate.
 *  · No live variant. The file is one row per variant, so there is no
 *    row to write — and a handle with no rows says nothing.
 *
 * Neither is reachable through the console, which always writes a slug
 * and requires at least one variant.
 */
export async function* exportCatalogCsv(tenantId: string): AsyncGenerator<string> {
  // A UTF-8 BOM, deliberately. Excel on Windows reads a BOM-less CSV as
  // the system codepage, so a Devanagari or Tamil product name opens as
  // mojibake and the merchant concludes the export is broken. The
  // importer strips it again, so this costs the round trip nothing.
  yield `﻿${catalogCsvHeader()}`;

  let afterId: string | null = null;

  for (;;) {
    const page = await listProductsForExport(tenantId, { afterId, limit: EXPORT_PAGE_SIZE });
    if (page.length === 0) return;

    for (const product of page) {
      if (product.slug === null || product.variants.length === 0) continue;

      const rows = productToCsvRows({
        slug: product.slug,
        title: product.title,
        status: asCsvStatus(product.status),
        summary: product.summary,
        description: product.description,
        productType: product.productType,
        vendor: product.vendor,
        tags: product.tags,
        hsnCode: product.hsnCode,
        taxRateBps: product.taxRateBps,
        seo: seoOf(product.seo),
        axes: product.axes,
        variants: product.variants.map((v) => ({
          sku: v.sku,
          barcode: v.barcode,
          options: v.options as OptionSelection,
          pricePaise: v.pricePaise,
          compareAtPaise: v.compareAtPaise,
          costPaise: v.costPaise,
          weightGrams: v.weightGrams,
          lowStockAt: v.lowStockAt,
          isActive: v.isActive,
        })),
      });

      yield rows.join("");
    }

    afterId = page[page.length - 1]?.id ?? null;
    if (afterId === null || page.length < EXPORT_PAGE_SIZE) return;
  }
}

/** The parity record above is what makes this total rather than a cast. */
function asCsvStatus(status: ProductStatus): CsvProductStatus {
  return STATUS_PARITY[status];
}

/**
 * The download's filename.
 *
 * Dated, because the first thing a merchant does with an export is take
 * a second one a week later and then need to tell them apart. Composed
 * entirely from characters this function chose — it ends up in a
 * `Content-Disposition` header, and a merchant-supplied name there is a
 * header-injection vector.
 */
export function catalogExportFilename(now = new Date()): string {
  return `catalog-${now.toISOString().slice(0, 10)}.csv`;
}
