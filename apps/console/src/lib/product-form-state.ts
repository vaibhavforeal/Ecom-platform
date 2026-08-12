import { optionKey, paiseToDecimalString } from "@platform/core/catalog";
import type { OptionSelection } from "@platform/core/catalog";
import type { ConsoleMedia, ConsoleProduct } from "@platform/core/catalog/server";

/**
 * The shape the product form edits, and the two ways of getting one.
 *
 * PURE, and imported by both the server pages and the client form — so
 * it must stay free of any value import from `@platform/core/…/server`
 * or `@platform/db`. The `ConsoleProduct` import above is `import type`
 * and is erased at compile time; making it a value import is what would
 * drag the postgres driver into the browser bundle and fail the build on
 * `net`/`fs`/`perf_hooks`.
 *
 * Every numeric field is a STRING here. A form input holds text, and a
 * half-typed "12." is not a number — coercing on every keystroke is how
 * a field clears itself while the merchant is still typing in it.
 */

export type AxisFormRow = {
  /** Stable React key. Not sent — the axes have no identity in the database. */
  key: string;
  name: string;
  /** Comma-separated, which is how a merchant types "S, M, L". */
  values: string;
};

export type VariantFormRow = {
  key: string;
  /** The row this edits, or null for a new one. */
  id: string | null;
  sku: string;
  barcode: string;
  options: OptionSelection;
  /** Rupees, as typed. Converted to paise at the request boundary. */
  price: string;
  compareAt: string;
  cost: string;
  weightGrams: string;
  lowStockAt: string;
  imageMediaId: string;
  isActive: boolean;
};

export type ProductFormState = {
  title: string;
  slug: string;
  summary: string;
  description: string;
  status: "draft" | "active" | "archived";
  productType: string;
  vendor: string;
  /** Comma-separated. */
  tags: string;
  hsnCode: string;
  /** A percent, as typed. 5 or 12.5. */
  taxRatePercent: string;
  seoTitle: string;
  seoDescription: string;
  noindex: boolean;
  axes: AxisFormRow[];
  variants: VariantFormRow[];
  categoryIds: string[];
  collectionIds: string[];
  /**
   * `alt` is `string | null`, and null is not "empty" — it is "this form
   * has nothing to say about the alt text, leave whatever is stored".
   * The write layer honours exactly that (`writeGallery` skips null),
   * and it has to, because `alt` lives on `media` rather than on the
   * join: a blank sent for one product clears that sentence on EVERY
   * product using the same photograph. A freshly uploaded image whose
   * alt the merchant has not typed is null, not "".
   */
  media: { mediaId: string; alt: string | null }[];
};

export type MediaOption = {
  id: string;
  url: string;
  storageKey: string;
  /** Null when the image has no alt text stored. See `ProductFormState.media`. */
  alt: string | null;
  status: MediaStatus;
  processingError: string | null;
};

export type MediaStatus = "pending" | "ready" | "failed";

/**
 * Narrows whatever `/api/media/upload` answered to a status the form can
 * render, defaulting to `pending`.
 *
 * Collapsing anything-not-`ready` to `pending` is what this replaces:
 * `failed` and `pending` read identically to the merchant, and the form
 * then tells them a permanently failed image is "still processing".
 */
export function mediaStatusFrom(value: unknown): MediaStatus {
  return value === "ready" || value === "failed" ? value : "pending";
}

export type TaxonomyOption = { id: string; title: string; isVisible: boolean };

let counter = 0;
/** Unique within one form session; never persisted. */
export function formKey(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function blankVariant(options: OptionSelection = {}): VariantFormRow {
  return {
    key: formKey("v"),
    id: null,
    sku: "",
    barcode: "",
    options,
    price: "",
    compareAt: "",
    cost: "",
    // Deliberately blank rather than "0". A variant that silently
    // weighed nothing would quote shipping at zero, and Phase 3 rates
    // every parcel from this number.
    weightGrams: "",
    lowStockAt: "",
    imageMediaId: "",
    isActive: true,
  };
}

export function blankProduct(): ProductFormState {
  return {
    title: "",
    slug: "",
    summary: "",
    description: "",
    status: "draft",
    productType: "",
    vendor: "",
    tags: "",
    hsnCode: "",
    taxRatePercent: "",
    seoTitle: "",
    seoDescription: "",
    noindex: false,
    axes: [],
    // Every product has at least one variant — that is what keeps cart,
    // invoice and POS free of a "does this have variants?" branch.
    variants: [blankVariant()],
    categoryIds: [],
    collectionIds: [],
    media: [],
  };
}

export function toFormState(product: ConsoleProduct): ProductFormState {
  const seo = product.seo as { title?: string; description?: string; noindex?: boolean };

  return {
    title: product.title,
    slug: product.slug ?? "",
    summary: product.summary ?? "",
    description: product.description ?? "",
    status: product.status,
    productType: product.productType ?? "",
    vendor: product.vendor ?? "",
    tags: product.tags.join(", "),
    hsnCode: product.hsnCode ?? "",
    // Basis points back to a percent, through the same integer path.
    taxRatePercent:
      product.taxRateBps === null ? "" : trimZeros(paiseToDecimalString(product.taxRateBps)),
    seoTitle: typeof seo.title === "string" ? seo.title : "",
    seoDescription: typeof seo.description === "string" ? seo.description : "",
    noindex: seo.noindex === true,
    axes: product.axes.map((axis) => ({
      key: formKey("a"),
      name: axis.name,
      values: axis.values.join(", "),
    })),
    variants: product.variants.map((v) => ({
      key: formKey("v"),
      id: v.id,
      sku: v.sku,
      barcode: v.barcode ?? "",
      options: v.options,
      price: paiseToDecimalString(v.pricePaise),
      compareAt: v.compareAtPaise === null ? "" : paiseToDecimalString(v.compareAtPaise),
      cost: v.costPaise === null ? "" : paiseToDecimalString(v.costPaise),
      weightGrams: String(v.weightGrams),
      lowStockAt: v.lowStockAt === null ? "" : String(v.lowStockAt),
      imageMediaId: v.imageMediaId ?? "",
      isActive: v.isActive,
    })),
    categoryIds: product.categoryIds,
    collectionIds: product.collectionIds,
    // `m.alt` passes through as-is, null included. Coercing a stored
    // NULL to "" here would write "" back on the next save of a product
    // whose alt nobody touched — a write, on a column shared with every
    // other product using the image.
    media: product.media.map((m) => ({ mediaId: m.id, alt: m.alt })),
  };
}

/** "5.00" → "5", "12.50" → "12.5". Cosmetic, for a field a human retypes. */
function trimZeros(decimal: string): string {
  return decimal.replace(/\.?0+$/, "") || "0";
}

export function toMediaOption(
  media: ConsoleMedia,
  url: string,
): MediaOption {
  return {
    id: media.id,
    url,
    storageKey: media.storageKey,
    alt: media.alt,
    status: media.status,
    processingError: media.processingError,
  };
}

/** Parses "S, M, L" into the axis values, dropping blanks and duplicates. */
export function parseAxisValues(raw: string): string[] {
  return [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))];
}

export function parseTags(raw: string): string[] {
  return [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))];
}

/**
 * Reconciles the variant list against the axes the merchant just
 * declared.
 *
 * Existing variants are matched by their option combination rather than
 * by position, so adding "XL" to a Size axis keeps the prices and SKUs
 * already typed against S, M and L instead of shuffling them. A
 * combination that no longer exists is dropped — and because the write
 * layer soft-deletes rather than deletes, the row survives for whatever
 * order history references it.
 */
export function rebuildMatrix(
  combinations: OptionSelection[],
  existing: VariantFormRow[],
): VariantFormRow[] {
  const byCombination = new Map(existing.map((v) => [optionKey(v.options), v]));

  if (combinations.length === 0) {
    // No axes: exactly one variant, carrying no options.
    const kept = existing[0] ?? blankVariant();
    return [{ ...kept, options: {} }];
  }

  return combinations.map((options) => {
    const match = byCombination.get(optionKey(options));
    if (match) return { ...match, options };

    // A new cell inherits price and weight from the first row that has
    // them. Retyping ₹1,299 across twelve sizes is how a merchant
    // decides the console is not worth using.
    const template = existing[0];
    return {
      ...blankVariant(options),
      price: template?.price ?? "",
      compareAt: template?.compareAt ?? "",
      cost: template?.cost ?? "",
      weightGrams: template?.weightGrams ?? "",
      lowStockAt: template?.lowStockAt ?? "",
    };
  });
}
