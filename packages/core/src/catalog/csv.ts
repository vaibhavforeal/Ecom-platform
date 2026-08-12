import { InvalidAmountError, paiseToDecimalString, parseAmountToPaise } from "./money";
import type { OptionAxis, OptionSelection } from "./options";
import { slugify } from "./slug";

/**
 * Bulk catalog CSV — PURE, and therefore safe in a client bundle.
 *
 * This is the migration path onto the platform: a merchant arriving with
 * an existing catalog will not retype it. Everything here is parsing,
 * validation and serialisation over strings; the database work lives in
 * `./bulk`, behind `@platform/core/catalog/server`.
 *
 * Three properties this file exists to guarantee:
 *
 *  1. **A cell that cannot be read is an ERROR, never a default.** A
 *     price that does not parse must not become ₹0 — that is a product
 *     listed at nothing, sold at nothing, and discovered at the end of
 *     the month. Every issue is reported with the row number the
 *     merchant sees in their spreadsheet and the column it came from, so
 *     a 400-row file is fixable in one pass.
 *
 *  2. **Export is the exact inverse of import.** A file exported and
 *     re-imported unchanged is a no-op — not "an idempotent rewrite", an
 *     actual no-op with no audit row and no `updated_at` bump. Every
 *     encoding decision below is reversed by the parser in this same
 *     file, and there is a round-trip test.
 *
 *  3. **Nothing here trusts a header, a cell or a length.** The importer
 *     deliberately bypasses the console's zod boundary — it is not
 *     parsing a form — which makes every cap that schema applies this
 *     file's job instead.
 *
 * The shape is one row per VARIANT, with the product identified by a
 * `handle` column repeated across its variant rows. That is what
 * merchants export from the platforms they are leaving, so it is the
 * shape that can be pasted in.
 */

// ───────────────────────────────────────────────────────────────
// Limits
// ───────────────────────────────────────────────────────────────

/**
 * A hard ceiling on the upload, counted off the socket.
 *
 * 5 MB of CSV is well past `MAX_IMPORT_ROWS` rows of ordinary width, so
 * the row cap is what a real merchant meets and this is what a hostile
 * upload meets.
 */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * Variant rows per file. The whole import runs in ONE transaction, so
 * this is also the ceiling on how long that transaction holds its locks.
 * A merchant with more than this splits the file; nobody has asked to.
 */
export const MAX_IMPORT_ROWS = 5_000;

/** Three axes is what the console allows, so it is what the CSV allows. */
export const MAX_OPTION_AXES = 3;

// Field caps, matching the console's zod schema field for field.
const MAX_HANDLE = 200;
const MAX_TITLE = 200;
const MAX_SUMMARY = 500;
const MAX_DESCRIPTION = 60_000;
const MAX_PRODUCT_TYPE = 80;
const MAX_VENDOR = 120;
const MAX_TAG = 40;
const MAX_TAGS = 50;
const MAX_HSN = 12;
const MAX_SEO_TITLE = 120;
const MAX_SEO_DESCRIPTION = 320;
const MAX_OPTION_NAME = 40;
const MAX_OPTION_VALUE = 60;
const MAX_SKU = 64;
const MAX_BARCODE = 64;
const MAX_AMOUNT_TEXT = 24;
const MAX_WEIGHT_GRAMS = 500_000;
const MAX_LOW_STOCK_AT = 100_000;
const MAX_TAX_RATE_BPS = 10_000;

// ───────────────────────────────────────────────────────────────
// Columns
// ───────────────────────────────────────────────────────────────

/**
 * Every column the importer understands, in the order export writes them:
 * the product, then the option matrix, then the variant's own fields.
 */
export const CSV_COLUMNS = [
  "handle",
  "title",
  "status",
  "summary",
  "description",
  "product_type",
  "vendor",
  "tags",
  "hsn_code",
  "tax_rate_percent",
  "seo_title",
  "seo_description",
  "seo_noindex",
  "option1_name",
  "option1_value",
  "option2_name",
  "option2_value",
  "option3_name",
  "option3_value",
  "sku",
  "barcode",
  "price",
  "compare_at_price",
  "cost",
  "weight_grams",
  "low_stock_at",
  "variant_active",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/**
 * Columns without which a row cannot become a variant.
 *
 * `weight_grams` is here with the other four on purpose. Every courier
 * rate in Phase 3 is computed from billable weight, so a variant that
 * silently weighed zero would quote shipping at zero and be discovered
 * at the first weight-dispute invoice — the same failure as a ₹0 price,
 * one step further downstream.
 */
export const REQUIRED_CSV_COLUMNS = [
  "handle",
  "title",
  "sku",
  "price",
  "weight_grams",
] as const;

/**
 * Statuses a `status` cell may name.
 *
 * Written out rather than imported from `@platform/db`, which would drag
 * the postgres driver into the client bundle even as a type-only import
 * one careless edit later. `./bulk` holds a compile-time check that this
 * list and `PRODUCT_STATUSES` still agree.
 */
export const CSV_PRODUCT_STATUSES = ["draft", "active", "archived"] as const;
export type CsvProductStatus = (typeof CSV_PRODUCT_STATUSES)[number];

// ───────────────────────────────────────────────────────────────
// Issues
// ───────────────────────────────────────────────────────────────

/**
 * One thing wrong with one cell.
 *
 * `row` is the RECORD index as a spreadsheet counts it: the header is
 * row 1 and the first variant is row 2, whatever number of physical
 * lines a quoted cell spans. That is the number down the left-hand side
 * of the merchant's spreadsheet, and a report they cannot navigate by is
 * a report they ignore.
 */
export type CsvIssue = {
  row: number;
  /** The header the problem belongs to, or null for a whole-row problem. */
  column: string | null;
  message: string;
};

/** A file that is not CSV at all — an unterminated quote, so far. */
export class CsvFormatError extends Error {
  readonly row: number;

  constructor(row: number, message: string) {
    super(message);
    this.name = "CsvFormatError";
    this.row = row;
  }
}

// ───────────────────────────────────────────────────────────────
// The reader
// ───────────────────────────────────────────────────────────────

type ReaderState = "field_start" | "unquoted" | "quoted" | "after_quote";

/**
 * An incremental RFC 4180 reader.
 *
 * Incremental because the upload is streamed: the route feeds it decoded
 * chunks as they come off the socket and stops the moment the row cap or
 * the byte cap is hit, rather than buffering a hostile file into memory
 * and counting afterwards.
 *
 * Blank lines in the middle of a file are emitted as records rather than
 * silently dropped. They are noise and the caller ignores them — but a
 * spreadsheet counts a blank line as a row, so swallowing one here would
 * shift every row number after it and point the whole error report one
 * line off.
 */
export class CsvRecordReader {
  private state: ReaderState = "field_start";
  private field = "";
  private record: string[] = [];
  private pendingLf = false;
  private atStart = true;
  private emitted = 0;

  /** Decoded text in, complete records out. */
  push(chunk: string): string[][] {
    let text = chunk;

    // A UTF-8 BOM. Excel writes one on every CSV it saves, and left in
    // place it becomes part of the FIRST header name — so `handle`
    // arrives as `﻿handle`, matches nothing, and a file with every
    // required column in it is rejected for missing one.
    if (this.atStart) {
      if (text.startsWith("﻿")) text = text.slice(1);
      this.atStart = false;
    }

    const records: string[][] = [];

    for (const char of text) {
      if (this.pendingLf) {
        this.pendingLf = false;
        // The \n of a \r\n pair, already accounted for by the \r.
        if (char === "\n") continue;
      }

      switch (this.state) {
        case "field_start":
          if (char === '"') this.state = "quoted";
          else if (char === ",") this.record.push("");
          else if (char === "\r" || char === "\n") this.endRecord(char, records);
          else {
            this.field = char;
            this.state = "unquoted";
          }
          break;

        case "unquoted":
          if (char === ",") this.endField();
          else if (char === "\r" || char === "\n") this.endRecord(char, records);
          else this.field += char;
          break;

        case "quoted":
          // Separators are literal in here, newlines included.
          if (char === '"') this.state = "after_quote";
          else this.field += char;
          break;

        case "after_quote":
          if (char === '"') {
            // "" inside a quoted field is one literal quote.
            this.field += '"';
            this.state = "quoted";
          } else if (char === ",") this.endField();
          else if (char === "\r" || char === "\n") this.endRecord(char, records);
          else {
            // `"a"b` — malformed, and every spreadsheet reads it as `ab`.
            this.field += char;
            this.state = "unquoted";
          }
          break;
      }
    }

    return records;
  }

  /** Flushes whatever the last chunk left mid-record. */
  end(): string[][] {
    if (this.state === "quoted") {
      throw new CsvFormatError(
        this.emitted + 1,
        "The file ends inside a quoted value — a quote is not closed.",
      );
    }

    // A file ending in a newline is normal, and does NOT mean one more
    // empty row.
    if (this.state === "field_start" && this.field === "" && this.record.length === 0) {
      return [];
    }

    const records: string[][] = [];
    this.flush(records);
    return records;
  }

  private endField(): void {
    this.record.push(this.field);
    this.field = "";
    this.state = "field_start";
  }

  private endRecord(char: string, out: string[][]): void {
    if (char === "\r") this.pendingLf = true;
    this.flush(out);
  }

  private flush(out: string[][]): void {
    this.record.push(this.field);
    out.push(this.record);
    this.emitted += 1;
    this.field = "";
    this.record = [];
    this.state = "field_start";
  }
}

/** The whole-string form, for tests and for files already in memory. */
export function parseCsvRecords(text: string): string[][] {
  const reader = new CsvRecordReader();
  return [...reader.push(text), ...reader.end()];
}

// ───────────────────────────────────────────────────────────────
// The formula guard
// ───────────────────────────────────────────────────────────────

/**
 * Leading characters that make Excel, LibreOffice and Sheets treat a
 * cell as a FORMULA rather than as text. `=cmd|'/c calc'!A0` sitting in
 * a product title is a command-execution prompt in whoever's spreadsheet
 * opens the export — and CSV quoting does not help, because the quotes
 * are syntax the spreadsheet strips before it decides.
 */
const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Escapes a value so no spreadsheet will evaluate it, REVERSIBLY.
 *
 * A leading apostrophe is the convention every spreadsheet already uses
 * for "this is literally text". Values that already begin with one are
 * doubled, which makes this a bijection — so `unescapeFormula` restores
 * the original exactly and the round trip stays a no-op. The usual fix
 * (prefix unconditionally, never strip) is not reversible, and would
 * make every re-import a rewrite and every re-export longer again.
 */
function escapeFormula(value: string): string {
  const first = value.charAt(0);
  return first === "'" || FORMULA_LEAD.has(first) ? `'${value}` : value;
}

function unescapeFormula(value: string): string {
  return value.charAt(0) === "'" ? value.slice(1) : value;
}

// ───────────────────────────────────────────────────────────────
// Serialising
// ───────────────────────────────────────────────────────────────

/** RFC 4180 quoting, plus the formula guard. */
export function formatCsvValue(value: string): string {
  const guarded = escapeFormula(value);
  const needsQuotes =
    guarded.includes(",") ||
    guarded.includes('"') ||
    guarded.includes("\n") ||
    guarded.includes("\r") ||
    guarded !== guarded.trim();

  return needsQuotes ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** One record, CRLF-terminated — the line ending the RFC specifies. */
export function formatCsvRecord(values: readonly string[]): string {
  return `${values.map(formatCsvValue).join(",")}\r\n`;
}

export function catalogCsvHeader(): string {
  return formatCsvRecord(CSV_COLUMNS);
}

/** What export knows about one product — the inverse of what import writes. */
export type ExportProduct = {
  slug: string;
  title: string;
  status: CsvProductStatus;
  summary: string | null;
  description: string | null;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  hsnCode: string | null;
  taxRateBps: number | null;
  seo: { title?: string | null; description?: string | null; noindex?: boolean };
  axes: OptionAxis[];
  variants: ExportVariant[];
};

export type ExportVariant = {
  sku: string;
  barcode: string | null;
  options: OptionSelection;
  pricePaise: number;
  compareAtPaise: number | null;
  costPaise: number | null;
  weightGrams: number;
  lowStockAt: number | null;
  isActive: boolean;
};

/**
 * A product as CSV lines — one per variant, product columns repeated.
 *
 * Repeated on every row rather than written on the first, which is what
 * the platforms merchants come from do. Repetition costs bytes and buys
 * two things: the file survives being sorted or filtered in a
 * spreadsheet, which is the first thing anyone does to it; and every row
 * is self-describing, so a merchant pasting one row into a new file gets
 * a product rather than a fragment.
 */
export function productToCsvRows(product: ExportProduct): string[] {
  const axes = product.axes.slice(0, MAX_OPTION_AXES);

  const productCells: Record<string, string> = {
    handle: product.slug,
    title: product.title,
    status: product.status,
    summary: product.summary ?? "",
    description: product.description ?? "",
    product_type: product.productType ?? "",
    vendor: product.vendor ?? "",
    tags: product.tags.join(", "),
    hsn_code: product.hsnCode ?? "",
    tax_rate_percent:
      product.taxRateBps === null ? "" : paiseToDecimalString(product.taxRateBps),
    seo_title: product.seo.title ?? "",
    seo_description: product.seo.description ?? "",
    seo_noindex: product.seo.noindex ? "true" : "false",
  };

  return product.variants.map((variant) => {
    const cells: Record<string, string> = { ...productCells };

    for (let i = 0; i < MAX_OPTION_AXES; i++) {
      const axis = axes[i];
      cells[`option${i + 1}_name`] = axis?.name ?? "";
      cells[`option${i + 1}_value`] = axis ? (variant.options[axis.name] ?? "") : "";
    }

    cells.sku = variant.sku;
    cells.barcode = variant.barcode ?? "";
    cells.price = paiseToDecimalString(variant.pricePaise);
    cells.compare_at_price =
      variant.compareAtPaise === null ? "" : paiseToDecimalString(variant.compareAtPaise);
    cells.cost = variant.costPaise === null ? "" : paiseToDecimalString(variant.costPaise);
    cells.weight_grams = String(variant.weightGrams);
    cells.low_stock_at = variant.lowStockAt === null ? "" : String(variant.lowStockAt);
    cells.variant_active = variant.isActive ? "true" : "false";

    return formatCsvRecord(CSV_COLUMNS.map((column) => cells[column] ?? ""));
  });
}

// ───────────────────────────────────────────────────────────────
// Drafts
// ───────────────────────────────────────────────────────────────

/**
 * A variant as one row states it.
 *
 * `undefined` on an optional field means the COLUMN was absent from the
 * file, and the importer must leave whatever is stored alone. `null`
 * means the column was there and the cell was blank, which is an
 * instruction to clear the field. Collapsing the two would make a
 * five-column CSV wipe every barcode in the catalog.
 */
export type CsvVariantDraft = {
  row: number;
  sku: string;
  pricePaise: number;
  weightGrams: number;
  barcode?: string | null;
  compareAtPaise?: number | null;
  costPaise?: number | null;
  lowStockAt?: number | null;
  isActive?: boolean;
  /** Absent when the file carries no option columns at all. */
  options?: OptionSelection;
};

export type CsvProductDraft = {
  /** Slugified, because that is what it is matched against. */
  handle: string;
  /** The first row carrying this handle, for product-level messages. */
  row: number;
  title: string;
  status?: CsvProductStatus;
  summary?: string | null;
  description?: string | null;
  productType?: string | null;
  vendor?: string | null;
  tags?: string[];
  hsnCode?: string | null;
  taxRateBps?: number | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoNoindex?: boolean;
  /** Axis names in option1..3 order; absent when no option columns exist. */
  optionNames?: string[];
  variants: CsvVariantDraft[];
};

export type ParsedCatalogCsv = {
  products: CsvProductDraft[];
  issues: CsvIssue[];
  /** Variant rows seen. Blank lines are not rows. */
  rowCount: number;
};

// ───────────────────────────────────────────────────────────────
// The report
// ───────────────────────────────────────────────────────────────

/**
 * What an import did, or would do.
 *
 * Declared here rather than beside the runner in `./bulk` for one
 * reason: the console's upload panel is a CLIENT component and has to
 * render this. Types are erased, so importing them from the server
 * barrel would work — right up until someone adds a value to the same
 * import statement and the postgres driver lands in the browser bundle.
 * Keeping the shape on the client-safe side removes the opportunity.
 */
export type ImportOutcome = "created" | "updated" | "skipped";

export type ImportProductResult = {
  handle: string;
  /** The first row of this product's group, as the spreadsheet counts. */
  row: number;
  outcome: ImportOutcome;
  /**
   * Null for a product a DRY RUN would create.
   *
   * The dry run really does insert it and then rolls the transaction
   * back, so the id it saw will never exist. Reporting it anyway would
   * hand the console a link to a product that 404s.
   */
  productId: string | null;
  slug: string | null;
  variantsWritten: number;
  /** Live variants NOT named in the file. Kept, never deleted. */
  variantsRetained: number;
};

export type ImportReport = {
  /** False for a dry run, and for any file that had an error. */
  committed: boolean;
  /** Variant rows read. Blank lines are not rows. */
  rows: number;
  created: number;
  updated: number;
  /** Products already identical to the file — nothing was written. */
  skipped: number;
  /** Distinct rows carrying at least one error. */
  errored: number;
  issues: CsvIssue[];
  results: ImportProductResult[];
};

type Report = (column: string | null, message: string) => void;
type Cell = (column: CsvColumn) => string | undefined;
type Has = (column: CsvColumn) => boolean;

/**
 * Turns records into product drafts, collecting every problem.
 *
 * Nothing throws. A merchant fixing a 400-row file one error per upload
 * is a merchant who goes back to their old platform, so every issue in
 * the file comes back at once.
 */
export function parseCatalogCsv(records: string[][]): ParsedCatalogCsv {
  const issues: CsvIssue[] = [];
  const products: CsvProductDraft[] = [];

  const header = records[0];
  if (!header) {
    issues.push({ row: 1, column: null, message: "The file is empty." });
    return { products, issues, rowCount: 0 };
  }

  // Header names are merchant-supplied too. Normalised, then matched
  // against the known set; anything else is IGNORED rather than trusted,
  // because an unrecognised column is usually a leftover from the
  // platform the merchant is leaving, not an instruction.
  const known = new Set<string>(CSV_COLUMNS);
  const indexOf = new Map<CsvColumn, number>();

  header.forEach((raw, i) => {
    // `trim()` is belt and braces on the reader's BOM strip: JS counts
    // U+FEFF as whitespace, so a BOM that somehow reached here would be
    // removed a second time rather than becoming part of a column name.
    const name = raw.trim().toLowerCase();
    if (!known.has(name)) return;
    const column = name as CsvColumn;
    if (indexOf.has(column)) {
      issues.push({
        row: 1,
        column,
        message: `The column "${column}" appears more than once. Keep one of them.`,
      });
      return;
    }
    indexOf.set(column, i);
  });

  for (const column of REQUIRED_CSV_COLUMNS) {
    if (!indexOf.has(column)) {
      issues.push({
        row: 1,
        column,
        // Reported, and then parsing CONTINUES. One upload should
        // surface every problem in the file, not only the first.
        message: `The column "${column}" is required and is not in this file.`,
      });
    }
  }

  const has = (column: CsvColumn): boolean => indexOf.has(column);
  const optionColumns = OPTION_INDEXES.some(
    (i) => has(`option${i}_name` as CsvColumn) || has(`option${i}_value` as CsvColumn),
  );

  const byHandle = new Map<string, CsvProductDraft>();
  /** Axis names per handle, by slot, so a hole is visible rather than shifted away. */
  const axisSlots = new Map<string, (string | null)[]>();
  /**
   * Every readable SKU and the row it was on, collected independently of
   * whether the rest of the row parsed. A file that is BOTH missing a
   * required column and repeating a SKU should report both, rather than
   * hiding the second behind the first.
   */
  const skuRows: { sku: string; row: number }[] = [];
  let rowCount = 0;

  for (let r = 1; r < records.length; r++) {
    const record = records[r];
    if (!record) continue;
    // Spreadsheets leave blank rows behind constantly. Ignored — but
    // still counted in `row`, so the numbers keep matching the sheet.
    if (record.every((value) => value.trim() === "")) continue;

    const row = r + 1;
    rowCount += 1;

    const report: Report = (column, message) => issues.push({ row, column, message });

    /**
     * Trimmed, because a stray space around a SKU or a title is a
     * spreadsheet artefact rather than data. `description` is the one
     * exception: it is an HTML blob whose exact bytes are what the
     * export wrote, and trimming it would make every re-import of a
     * description ending in a newline look like an edit.
     */
    const cell: Cell = (column) => {
      const i = indexOf.get(column);
      if (i === undefined) return undefined;
      const raw = unescapeFormula(record[i] ?? "");
      return column === "description" ? raw : raw.trim();
    };

    const handle = readHandle(cell("handle"), report);
    const sku = readSku(cell("sku"), report);
    if (sku !== null) skuRows.push({ sku, row });

    const variant = readVariant(sku, cell, has, row, report);

    if (handle === null) continue;

    let draft = byHandle.get(handle);
    if (!draft) {
      draft = { handle, row, title: "", variants: [] };
      byHandle.set(handle, draft);
      axisSlots.set(handle, OPTION_INDEXES.map(() => null));
      products.push(draft);
    }

    const slots = axisSlots.get(handle) ?? [];
    mergeProductFields(draft, cell, has, report);
    if (optionColumns) mergeAxisNames(draft, slots, cell, has, report);

    if (variant === null) continue;

    // Read against the names resolved so far, so this must follow
    // `mergeAxisNames` — which is why export writes the option names on
    // every row rather than only the first.
    if (optionColumns) variant.options = readOptions(slots, cell, report);

    draft.variants.push(variant);
  }

  // Deferred to here because product columns may legitimately be stated
  // on any row of a handle: the platforms merchants come from write them
  // on the first row of the group only.
  for (const draft of products) {
    if (draft.title === "" && has("title")) {
      issues.push({ row: draft.row, column: "title", message: "A product needs a title." });
    }
    if (draft.variants.length === 0) {
      issues.push({
        row: draft.row,
        column: null,
        message: `No usable variant rows for "${draft.handle}".`,
      });
    }
    if (optionColumns) {
      draft.optionNames = finaliseAxisNames(draft, axisSlots.get(draft.handle) ?? [], issues);
    }
    // The column exists and no row filled it in: "not hidden from search".
    if (has("seo_noindex")) draft.seoNoindex ??= false;
  }

  issues.push(...duplicateSkuIssues(skuRows));

  return { products, issues, rowCount };
}

const OPTION_INDEXES = [1, 2, 3] as const;

// ───────────────────────────────────────────────────────────────
// Product-level columns
// ───────────────────────────────────────────────────────────────

/**
 * The product columns of one row, folded into the handle's draft.
 *
 * The value is the first NON-BLANK one across the handle's rows; a later
 * row stating something DIFFERENT is an error rather than a silent
 * winner. Two rows of one product disagreeing about its title is a
 * merchant who edited one and forgot the other, and picking either
 * quietly discards half of what they meant.
 *
 * A column that is blank on every row of a handle clears the field — a
 * column absent from the FILE leaves it alone. That difference is what
 * keeps a five-column CSV from wiping every summary in the catalog.
 */
function mergeProductFields(draft: CsvProductDraft, cell: Cell, has: Has, report: Report): void {
  const text = (
    column: CsvColumn,
    max: number,
    current: string | null | undefined,
  ): string | null | undefined => {
    if (!has(column)) return undefined;
    const value = cell(column) ?? "";
    if (value === "") return current === undefined ? null : current;
    if (value.length > max) {
      report(column, `This cannot be longer than ${max} characters.`);
      return current;
    }
    if (current !== undefined && current !== null && current !== value) {
      report(column, disagreement(draft, column));
      return current;
    }
    return value;
  };

  // Title carries its own branch because it is not nullable: blank
  // leaves whatever another row set, and "no row set one" is caught
  // after every row has been read.
  if (has("title")) {
    const value = cell("title") ?? "";
    if (value.length > MAX_TITLE) {
      report("title", `A title cannot be longer than ${MAX_TITLE} characters.`);
    } else if (value !== "") {
      if (draft.title !== "" && draft.title !== value) report("title", disagreement(draft, "title"));
      else draft.title = value;
    }
  }

  draft.summary = text("summary", MAX_SUMMARY, draft.summary);
  draft.description = text("description", MAX_DESCRIPTION, draft.description);
  draft.productType = text("product_type", MAX_PRODUCT_TYPE, draft.productType);
  draft.vendor = text("vendor", MAX_VENDOR, draft.vendor);
  draft.hsnCode = text("hsn_code", MAX_HSN, draft.hsnCode);
  draft.seoTitle = text("seo_title", MAX_SEO_TITLE, draft.seoTitle);
  draft.seoDescription = text("seo_description", MAX_SEO_DESCRIPTION, draft.seoDescription);

  if (has("status")) {
    const value = (cell("status") ?? "").toLowerCase();
    if (value !== "") {
      if (!(CSV_PRODUCT_STATUSES as readonly string[]).includes(value)) {
        report("status", `"${value}" is not a status. Use ${CSV_PRODUCT_STATUSES.join(", ")}.`);
      } else if (draft.status !== undefined && draft.status !== value) {
        report("status", disagreement(draft, "status"));
      } else {
        draft.status = value as CsvProductStatus;
      }
    }
  }

  if (has("tags")) {
    const tags = readTags(cell("tags") ?? "", report);
    if (tags !== null) {
      if (draft.tags === undefined || draft.tags.length === 0) draft.tags = tags;
      else if (tags.length > 0 && !sameStrings(draft.tags, tags)) {
        report("tags", disagreement(draft, "tags"));
      }
    }
  }

  if (has("tax_rate_percent")) {
    const raw = cell("tax_rate_percent") ?? "";
    if (raw === "") {
      draft.taxRateBps ??= null;
    } else {
      const bps = readPercentAsBps(raw, report);
      if (bps !== undefined) {
        if (draft.taxRateBps !== undefined && draft.taxRateBps !== null && draft.taxRateBps !== bps) {
          report("tax_rate_percent", disagreement(draft, "tax_rate_percent"));
        } else {
          draft.taxRateBps = bps;
        }
      }
    }
  }

  if (has("seo_noindex")) {
    // A blank cell states nothing, so it neither sets nor conflicts. The
    // default is applied once, after every row has had its say.
    const value = readBoolean(cell("seo_noindex") ?? "", "seo_noindex", report);
    if (value !== undefined) {
      if (draft.seoNoindex !== undefined && draft.seoNoindex !== value) {
        report("seo_noindex", disagreement(draft, "seo_noindex"));
      } else draft.seoNoindex = value;
    }
  }
}

function disagreement(draft: CsvProductDraft, column: string): string {
  return (
    `"${draft.handle}" already gave a different ${column} on row ${draft.row}. ` +
    `Every row of a product must agree.`
  );
}

// ───────────────────────────────────────────────────────────────
// The option matrix
// ───────────────────────────────────────────────────────────────

function mergeAxisNames(
  draft: CsvProductDraft,
  slots: (string | null)[],
  cell: Cell,
  has: Has,
  report: Report,
): void {
  for (const n of OPTION_INDEXES) {
    const column = `option${n}_name` as CsvColumn;
    if (!has(column)) continue;

    const value = cell(column) ?? "";
    if (value === "") continue;

    if (value.length > MAX_OPTION_NAME) {
      report(column, `An option name cannot be longer than ${MAX_OPTION_NAME} characters.`);
      continue;
    }

    const existing = slots[n - 1];
    if (existing !== null && existing !== undefined && existing !== value) {
      report(
        column,
        `"${draft.handle}" already named this option "${existing}" on row ${draft.row}. ` +
          `Every row of a product must agree.`,
      );
      continue;
    }
    slots[n - 1] = value;
  }
}

/** Compacts the slots, refusing a gap or a repeat rather than shifting past it. */
function finaliseAxisNames(
  draft: CsvProductDraft,
  slots: (string | null)[],
  issues: CsvIssue[],
): string[] {
  const names: string[] = [];
  const last = slots.reduce((acc, name, i) => (name ? i : acc), -1);

  for (let i = 0; i <= last; i++) {
    const name = slots[i];
    if (!name) {
      // Compacting past a gap would put the axis at the wrong index and
      // mismatch every variant's option values silently.
      issues.push({
        row: draft.row,
        column: `option${i + 1}_name`,
        message: `Option ${i + 2} is named but option ${i + 1} is not. Fill the options in order.`,
      });
      continue;
    }
    if (names.includes(name)) {
      issues.push({
        row: draft.row,
        column: `option${i + 1}_name`,
        message: `Option "${name}" is declared twice.`,
      });
      continue;
    }
    names.push(name);
  }

  return names;
}

function readOptions(slots: (string | null)[], cell: Cell, report: Report): OptionSelection {
  const options: OptionSelection = {};

  for (const n of OPTION_INDEXES) {
    const name = slots[n - 1];
    const column = `option${n}_value` as CsvColumn;
    const value = cell(column);

    if (!name) {
      if (value !== undefined && value !== "") {
        report(column, `This row sets option ${n}, but no option${n}_name is given for this product.`);
      }
      continue;
    }

    if (value === undefined || value === "") {
      report(column, `This product has an option called "${name}", so every variant needs a value.`);
      continue;
    }

    if (value.length > MAX_OPTION_VALUE) {
      report(column, `An option value cannot be longer than ${MAX_OPTION_VALUE} characters.`);
      continue;
    }

    options[name] = value;
  }

  return options;
}

// ───────────────────────────────────────────────────────────────
// Cells
// ───────────────────────────────────────────────────────────────

/** The characters `slugify` keeps: a letter or a digit in any script. */
const SLUGGABLE = /[\p{L}\p{N}]/u;

function readHandle(raw: string | undefined, report: Report): string | null {
  if (raw === undefined) return null; // the missing-column issue is already filed
  if (raw === "") {
    report("handle", "Every row needs a handle — it is what groups a product's variants.");
    return null;
  }
  if (raw.length > MAX_HANDLE) {
    report("handle", `A handle cannot be longer than ${MAX_HANDLE} characters.`);
    return null;
  }

  // Tested before slugifying, not after. `slugify` FALLS BACK for input
  // it cannot reduce — "!!!" comes back as "item" — so a cell full of
  // punctuation would otherwise become a real handle, silently group
  // every such row into one product, and take the URL /item.
  if (!SLUGGABLE.test(raw)) {
    report("handle", `"${raw}" has no letters or digits, so it cannot be a handle.`);
    return null;
  }

  // Slugified here rather than at the boundary, because the handle IS
  // the product's URL and the write layer will slugify it anyway. Doing
  // it now means "Blue Shirt" and "blue-shirt" are one product rather
  // than two, which is what a merchant editing a spreadsheet expects.
  return slugify(raw, { fallback: "item" });
}

/**
 * The variant columns of one row.
 *
 * Null when the row cannot be a variant at all — and a row that comes
 * back null has already reported why.
 */
function readVariant(
  sku: string | null,
  cell: Cell,
  has: Has,
  row: number,
  report: Report,
): CsvVariantDraft | null {
  const pricePaise = readAmount(cell("price"), "price", report, { required: true });
  const weightGrams = readWeight(cell("weight_grams"), report);

  if (sku === null || pricePaise === undefined || weightGrams === null) return null;

  const draft: CsvVariantDraft = { row, sku, pricePaise, weightGrams };

  if (has("barcode")) draft.barcode = readBarcode(cell("barcode") ?? "", report);
  if (has("compare_at_price")) {
    draft.compareAtPaise =
      readAmount(cell("compare_at_price"), "compare_at_price", report, { required: false }) ?? null;
  }
  if (has("cost")) {
    draft.costPaise = readAmount(cell("cost"), "cost", report, { required: false }) ?? null;
  }
  if (has("low_stock_at")) draft.lowStockAt = readLowStock(cell("low_stock_at") ?? "", report);
  if (has("variant_active")) {
    draft.isActive = readBoolean(cell("variant_active") ?? "", "variant_active", report) ?? true;
  }

  return draft;
}

/**
 * Scientific notation where a code should be.
 *
 * Excel converts a 13-digit barcode to `9.78031E+12` the moment the file
 * is opened, and a long numeric SKU goes the same way. The original
 * digits are gone by then and nothing here recovers them — but writing
 * `9.78031E+12` into the barcode column as if it were a barcode is worse
 * than refusing the row and saying what happened. (The other half of the
 * same damage, `0012` losing its leading zeros, leaves no trace at all
 * and cannot be detected.)
 */
const SCIENTIFIC_NOTATION = /^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/;

const MANGLED = (raw: string, what: string): string =>
  `"${raw}" is scientific notation — a spreadsheet has rewritten this ${what}. ` +
  `Format the column as text and export it again.`;

function readSku(raw: string | undefined, report: Report): string | null {
  if (raw === undefined) return null; // missing column, already filed
  if (raw === "") {
    report("sku", "Every variant needs a SKU — it is how a row is matched to an existing variant.");
    return null;
  }
  if (raw.length > MAX_SKU) {
    report("sku", `A SKU cannot be longer than ${MAX_SKU} characters.`);
    return null;
  }
  if (SCIENTIFIC_NOTATION.test(raw)) {
    report("sku", MANGLED(raw, "SKU"));
    return null;
  }
  return raw;
}

function readBarcode(raw: string, report: Report): string | null {
  if (raw === "") return null;
  if (raw.length > MAX_BARCODE) {
    report("barcode", `A barcode cannot be longer than ${MAX_BARCODE} characters.`);
    return null;
  }
  if (SCIENTIFIC_NOTATION.test(raw)) {
    report("barcode", MANGLED(raw, "barcode"));
    return null;
  }
  return raw;
}

/**
 * A rupee amount → integer paise, through the money helpers.
 *
 * Never `parseFloat`, never `* 100`, and never a fallback: an amount
 * that does not parse is an error on that row, because a product
 * accidentally listed at ₹0 is real money lost every time it sells.
 */
function readAmount(
  raw: string | undefined,
  column: CsvColumn,
  report: Report,
  opts: { required: boolean },
): number | undefined {
  if (raw === undefined) return undefined; // missing column, already filed
  if (raw === "") {
    if (opts.required) report(column, "A price is required — a blank cell is not ₹0.");
    return undefined;
  }
  if (raw.length > MAX_AMOUNT_TEXT) {
    report(column, `An amount cannot be longer than ${MAX_AMOUNT_TEXT} characters.`);
    return undefined;
  }

  try {
    const paise = parseAmountToPaise(raw);
    if (paise < 0) {
      report(column, "An amount cannot be negative.");
      return undefined;
    }
    return paise;
  } catch (err) {
    // `InvalidAmountError` says exactly what is wrong and quotes nothing
    // but the merchant's own cell, so it is safe to show them.
    report(column, err instanceof InvalidAmountError ? err.message : "That is not a valid amount.");
    return undefined;
  }
}

/** A GST rate as a merchant types it — "5", "12.5" — into basis points. */
function readPercentAsBps(raw: string, report: Report): number | undefined {
  const bps = readAmount(raw, "tax_rate_percent", report, { required: false });
  if (bps === undefined) return undefined;
  if (bps > MAX_TAX_RATE_BPS) {
    report("tax_rate_percent", "A tax rate cannot exceed 100%.");
    return undefined;
  }
  return bps;
}

function readWeight(raw: string | undefined, report: Report): number | null {
  if (raw === undefined) return null; // missing column, already filed
  if (raw === "") {
    report(
      "weight_grams",
      "A weight is required — a blank cell would quote shipping at zero, not leave it unset.",
    );
    return null;
  }

  const grams = readWholeNumber(raw);
  if (grams === null) {
    report("weight_grams", `"${raw}" is not a whole number of grams.`);
    return null;
  }
  if (grams > MAX_WEIGHT_GRAMS) {
    report("weight_grams", `A parcel courier will not carry more than ${MAX_WEIGHT_GRAMS} grams.`);
    return null;
  }
  return grams;
}

function readLowStock(raw: string, report: Report): number | null {
  if (raw === "") return null;

  const value = readWholeNumber(raw);
  if (value === null) {
    report("low_stock_at", `"${raw}" is not a whole number.`);
    return null;
  }
  if (value > MAX_LOW_STOCK_AT) {
    report("low_stock_at", `This cannot be more than ${MAX_LOW_STOCK_AT}.`);
    return null;
  }
  return value;
}

/**
 * `1250`, `1,250` and `1250.00` are all 1250. `1250.5` is not a whole
 * number and is refused rather than rounded to something nobody chose.
 */
function readWholeNumber(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").replace(/\s/g, "");
  const match = /^(\d+)(?:\.0+)?$/.exec(cleaned);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "active", "t"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "inactive", "f"]);

/** Undefined for a blank cell, so each caller picks its own default. */
function readBoolean(raw: string, column: CsvColumn, report: Report): boolean | undefined {
  if (raw === "") return undefined;
  const value = raw.toLowerCase();
  if (TRUE_WORDS.has(value)) return true;
  if (FALSE_WORDS.has(value)) return false;
  report(column, `"${raw}" is not a yes or no. Use true or false.`);
  return undefined;
}

/** Comma-separated inside one cell, which is what merchants paste in. */
function readTags(raw: string, report: Report): string[] | null {
  if (raw === "") return [];

  const tags: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim();
    if (tag === "") continue;
    if (tag.length > MAX_TAG) {
      report("tags", `The tag "${tag}" is longer than ${MAX_TAG} characters.`);
      return null;
    }
    if (!tags.includes(tag)) tags.push(tag);
  }

  if (tags.length > MAX_TAGS) {
    report("tags", `A product cannot have more than ${MAX_TAGS} tags.`);
    return null;
  }
  return tags;
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * SKUs, which are unique per TENANT rather than per product.
 *
 * Caught here so a collision is a labelled row-and-column error rather
 * than an opaque failure from `product_variants_tenant_sku_key` halfway
 * through the transaction. The write layer checks the same SKUs against
 * the rest of the catalog; this checks them against the file.
 */
function duplicateSkuIssues(rows: { sku: string; row: number }[]): CsvIssue[] {
  const issues: CsvIssue[] = [];
  const seen = new Map<string, number>();

  for (const { sku, row } of rows) {
    const first = seen.get(sku);
    if (first === undefined) {
      seen.set(sku, row);
      continue;
    }
    issues.push({
      row,
      column: "sku",
      message: `The SKU "${sku}" is already used on row ${first}. Every variant needs its own.`,
    });
  }

  return issues;
}
