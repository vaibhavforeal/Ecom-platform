import { InvalidAmountError, parseAmountToPaise } from "@platform/core/catalog";
import type { ProductWriteInput, TaxonomyWriteInput } from "@platform/core/catalog/server";
import { PRODUCT_STATUSES } from "@platform/db";
import { z } from "zod";

/**
 * The console's request boundary for catalog writes.
 *
 * Nothing past this file trusts a form field. Everything a merchant's
 * browser sends arrives here as `unknown`, is parsed against a schema
 * that names every permitted key with a length on it, and leaves as a
 * typed `ProductWriteInput`.
 *
 * Two things are notable and deliberate:
 *
 *  · **There is no `tenantId` in any schema below.** The tenant comes
 *    from the session in the route handler and from nowhere else. A
 *    tenantId that merely LOOKS unused in a payload is one refactor away
 *    from being read.
 *
 *  · **Money arrives as the rupee string the merchant typed** and is
 *    converted here by `parseAmountToPaise`, which does integer
 *    arithmetic on the string rather than going through a float. The
 *    alternative — trusting a paise integer computed in the browser —
 *    puts the rounding decision in code we do not control.
 */

/** Trimmed, capped, and empty-to-null so a cleared field clears the column. */
function nullableText(max: number) {
  return z
    .string()
    .max(max)
    .transform((v) => v.trim() || null)
    .nullable()
    .default(null);
}

/** A merchant-typed rupee amount → integer paise. */
function rupees() {
  return z.string().max(24).transform(toPaise);
}

/** The same, where blank means "not set" rather than zero. */
function optionalRupees() {
  return z
    .string()
    .max(24)
    .nullable()
    .default(null)
    .transform((value, ctx) => {
      if (value === null || value.trim() === "") return null;
      return toPaise(value, ctx);
    });
}

function toPaise(value: string, ctx: z.RefinementCtx): number {
  try {
    const paise = parseAmountToPaise(value);
    if (paise < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "An amount cannot be negative." });
      return z.NEVER;
    }
    return paise;
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      // `InvalidAmountError` says exactly what is wrong with the string
      // and quotes nothing but the merchant's own input, so it is safe
      // to show them.
      message: err instanceof InvalidAmountError ? err.message : "That is not a valid amount.",
    });
    return z.NEVER;
  }
}

/**
 * A GST rate as a merchant types it — "5", "12.5" — into basis points.
 *
 * Percent-to-bps is the same ×100 conversion as rupees-to-paise, so it
 * reuses the same string arithmetic rather than `parseFloat(v) * 100` —
 * which turns "1.15" into 114.99999999999999, and then into either a
 * rate that is off by one basis point or a CHECK violation, depending on
 * where it is rounded.
 */
function optionalBasisPoints() {
  return z
    .string()
    .max(8)
    .nullable()
    .default(null)
    .transform((value, ctx) => {
      if (value === null || value.trim() === "") return null;

      const bps = toPaise(value, ctx);
      // `toPaise` returns `z.NEVER` — which is `undefined` at runtime —
      // after reporting why. Adding "cannot exceed 100%" on top of that
      // would tell the merchant a second thing that is not true.
      if (typeof bps !== "number") return z.NEVER;

      if (bps > 10_000) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A tax rate cannot exceed 100%." });
        return z.NEVER;
      }
      return bps;
    });
}

const seoSchema = z
  .object({
    title: z.string().max(120).optional(),
    description: z.string().max(320).optional(),
    noindex: z.boolean().optional(),
  })
  .default({});

const axisSchema = z.object({
  name: z.string().trim().min(1, "An option needs a name.").max(40),
  values: z.array(z.string().trim().min(1).max(60)).max(50),
});

const variantSchema = z.object({
  /**
   * Which existing variant this row edits. An id that does not belong to
   * the product is treated as a new variant by the write layer rather
   * than trusted — see `writeVariants`.
   */
  id: z.string().uuid().nullable().default(null),
  sku: z.string().trim().min(1, "Every variant needs a SKU.").max(64),
  barcode: nullableText(64),
  options: z.record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(60)).default({}),
  price: rupees(),
  compareAt: optionalRupees(),
  cost: optionalRupees(),
  /**
   * Required, with no default. Every courier rate in Phase 3 is computed
   * from billable weight, and a variant that silently weighed zero would
   * quote shipping at zero and be discovered at the first weight-dispute
   * invoice. 500 kg is the ceiling a parcel courier will carry.
   */
  weightGrams: z.number().int().min(0).max(500_000),
  lowStockAt: z.number().int().min(0).max(100_000).nullable().default(null),
  imageMediaId: z.string().uuid().nullable().default(null),
  isActive: z.boolean().default(true),
});

export const productPayloadSchema = z.object({
  title: z.string().trim().min(1, "A product needs a title.").max(200),
  /** Blank means "derive it from the title". */
  slug: z.string().trim().max(96).nullable().default(null),
  summary: nullableText(500),
  /**
   * RAW merchant HTML, capped at a length no honest description reaches.
   * It is sanitised by the write layer, not here — one place, so no
   * future writer can forget.
   */
  description: z.string().max(60_000).nullable().default(null),
  status: z.enum(PRODUCT_STATUSES),
  productType: nullableText(80),
  vendor: nullableText(120),
  tags: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
  hsnCode: nullableText(12),
  /** Typed as a percent, stored as basis points. 5 → 500. */
  taxRatePercent: optionalBasisPoints(),
  seo: seoSchema,
  // Three axes is Shopify's limit and nobody has asked it to be higher;
  // the cartesian product of four is a matrix no one edits by hand.
  axes: z.array(axisSchema).max(3).default([]),
  variants: z.array(variantSchema).min(1, "A product needs at least one variant.").max(200),
  categoryIds: z.array(z.string().uuid()).max(50).default([]),
  collectionIds: z.array(z.string().uuid()).max(50).default([]),
  media: z
    .array(
      z.object({
        mediaId: z.string().uuid(),
        /** null leaves the image's existing alt text alone. */
        alt: z.string().max(300).nullable().default(null),
      }),
    )
    .max(30)
    .default([]),
});

export type ProductPayload = z.infer<typeof productPayloadSchema>;

/** Maps the wire shape onto the domain shape. Only field renames happen here. */
export function toProductWriteInput(payload: ProductPayload): ProductWriteInput {
  return {
    title: payload.title,
    slug: payload.slug,
    summary: payload.summary,
    description: payload.description,
    status: payload.status,
    productType: payload.productType,
    vendor: payload.vendor,
    tags: payload.tags,
    hsnCode: payload.hsnCode,
    taxRateBps: payload.taxRatePercent,
    seo: payload.seo,
    axes: payload.axes,
    variants: payload.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      barcode: v.barcode,
      options: v.options,
      pricePaise: v.price,
      compareAtPaise: v.compareAt,
      costPaise: v.cost,
      weightGrams: v.weightGrams,
      lowStockAt: v.lowStockAt,
      imageMediaId: v.imageMediaId,
      isActive: v.isActive,
    })),
    categoryIds: payload.categoryIds,
    collectionIds: payload.collectionIds,
    media: payload.media,
  };
}

export const taxonomyPayloadSchema = z.object({
  title: z.string().trim().min(1, "A title is required.").max(120),
  slug: z.string().trim().max(96).nullable().default(null),
  description: nullableText(2000),
  /** Categories only. A collection is flat and ignores this. */
  parentId: z.string().uuid().nullable().default(null),
  position: z.number().int().min(0).max(10_000).default(0),
  isVisible: z.boolean().default(true),
  seo: seoSchema,
});

export type TaxonomyPayload = z.infer<typeof taxonomyPayloadSchema>;

export function toTaxonomyWriteInput(payload: TaxonomyPayload): TaxonomyWriteInput {
  return payload;
}

/**
 * A zod failure, flattened into the same `{ path, message }` shape the
 * domain's own validation returns.
 *
 * One shape means the form has one renderer for both, rather than a
 * branch that gets the second case wrong.
 */
export function zodIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "form",
    message: issue.message,
  }));
}
