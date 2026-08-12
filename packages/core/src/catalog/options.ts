/**
 * Variant option matrices.
 *
 * The database stores a variant's position in the matrix as a flat JSONB
 * map — { "Size": "M", "Colour": "Red" } — per PLATFORM_BLUEPRINT.md
 * §3.2. A unique index stops two variants claiming the same combination,
 * but nothing in SQL can check that a combination names the axes the
 * product actually declared: that needs the whole product in view, which
 * is here.
 *
 * The failure this prevents is quiet. A variant carrying { "Size": "M" }
 * on a product whose axes are Size AND Colour is not a constraint
 * violation — it is a product whose PDP selector cannot resolve a
 * selection to a variant, so the Add to Cart button does nothing for
 * some combinations and works for others.
 */

export type OptionAxis = {
  name: string; // 'Size'
  values: string[]; // ['S', 'M', 'L'] — in display order
};

/** A variant's position in the matrix: axis name → chosen value. */
export type OptionSelection = Record<string, string>;

export type MatrixIssue = {
  code:
    | "duplicate_axis"
    | "duplicate_value"
    | "empty_axis"
    | "unknown_axis"
    | "missing_axis"
    | "unknown_value"
    | "duplicate_combination"
    | "unexpected_options"
    | "multiple_variants_without_options";
  message: string;
  /** Index into the variants array, when the issue belongs to one. */
  variantIndex?: number;
};

/**
 * A stable, order-independent key for a selection.
 *
 * `{ Size: 'M', Colour: 'Red' }` and `{ Colour: 'Red', Size: 'M' }` are
 * the same variant. Postgres normalises jsonb key order so the unique
 * index agrees; this makes the application agree too, rather than
 * relying on both sides happening to serialise in the same order.
 */
export function optionKey(selection: OptionSelection): string {
  // NUL between key and value, SOH between pairs. Not a space or a
  // colon: those occur in real option values ('1/2 in', 'Red: Matte'),
  // and a separator that can appear in the data lets two different
  // selections serialise to the same key.
  return Object.keys(selection)
    .sort()
    .map((k) => `${k}\u0000${selection[k] ?? ""}`)
    .join("\u0001");
}

/** Every combination the declared axes allow, in display order. */
export function cartesianCombinations(axes: OptionAxis[]): OptionSelection[] {
  return axes.reduce<OptionSelection[]>(
    (acc, axis) =>
      acc.flatMap((partial) => axis.values.map((value) => ({ ...partial, [axis.name]: value }))),
    [{}],
  );
}

/**
 * Validates a product's declared axes against its variants.
 *
 * Returns every issue rather than throwing on the first, because this
 * drives a form: a merchant fixing a 40-variant import one error per
 * save is a merchant who stops using the importer.
 */
export function validateVariantMatrix(
  axes: OptionAxis[],
  variants: { sku: string; options: OptionSelection }[],
): MatrixIssue[] {
  const issues: MatrixIssue[] = [];

  // ── The axes themselves ──
  const axisNames = new Set<string>();
  for (const axis of axes) {
    if (axisNames.has(axis.name)) {
      issues.push({ code: "duplicate_axis", message: `Option "${axis.name}" is declared twice.` });
    }
    axisNames.add(axis.name);

    if (axis.values.length === 0) {
      issues.push({
        code: "empty_axis",
        message: `Option "${axis.name}" has no values. Remove it or give it at least one.`,
      });
    }

    const seen = new Set<string>();
    for (const value of axis.values) {
      if (seen.has(value)) {
        issues.push({
          code: "duplicate_value",
          message: `Option "${axis.name}" lists "${value}" twice.`,
        });
      }
      seen.add(value);
    }
  }

  const allowed = new Map(axes.map((a) => [a.name, new Set(a.values)]));

  // ── A product with no options ──
  if (axes.length === 0) {
    // Exactly one variant, carrying no options. Every product has a
    // variant — that is what keeps cart, invoice and POS free of a
    // "does this have variants?" branch — so zero is as wrong as two.
    if (variants.length > 1) {
      issues.push({
        code: "multiple_variants_without_options",
        message:
          `This product has ${variants.length} variants but no options to tell them apart. ` +
          `Add an option, or keep a single variant.`,
      });
    }
    variants.forEach((v, i) => {
      if (Object.keys(v.options).length > 0) {
        issues.push({
          code: "unexpected_options",
          message: `Variant "${v.sku}" sets options, but this product declares none.`,
          variantIndex: i,
        });
      }
    });
    return issues;
  }

  // ── Each variant against the axes ──
  const combinations = new Map<string, number>();

  variants.forEach((variant, i) => {
    for (const [name, value] of Object.entries(variant.options)) {
      const values = allowed.get(name);
      if (!values) {
        issues.push({
          code: "unknown_axis",
          message: `Variant "${variant.sku}" sets "${name}", which is not an option on this product.`,
          variantIndex: i,
        });
        continue;
      }
      if (!values.has(value)) {
        issues.push({
          code: "unknown_value",
          message: `Variant "${variant.sku}" sets ${name}="${value}", which is not one of its permitted values.`,
          variantIndex: i,
        });
      }
    }

    for (const axis of axes) {
      if (!(axis.name in variant.options)) {
        issues.push({
          code: "missing_axis",
          message: `Variant "${variant.sku}" does not specify "${axis.name}".`,
          variantIndex: i,
        });
      }
    }

    const key = optionKey(variant.options);
    const first = combinations.get(key);
    if (first !== undefined) {
      issues.push({
        code: "duplicate_combination",
        message:
          `Variants "${variants[first]?.sku}" and "${variant.sku}" are the same combination. ` +
          `A selection has to resolve to exactly one variant.`,
        variantIndex: i,
      });
    } else {
      combinations.set(key, i);
    }
  });

  return issues;
}

/**
 * Which axis values can still be reached, given a partial selection.
 *
 * This is what lets a PDP grey out "XL" instead of hiding it or letting
 * the customer pick a combination that does not exist. Hiding is worse
 * than grey: a shopper who cannot see XL assumes the store does not
 * stock it, rather than that this colour does not come in XL.
 */
export function reachableValues(
  axes: OptionAxis[],
  variants: { options: OptionSelection }[],
  selection: OptionSelection,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const axis of axes) {
    // Hold every OTHER axis of the selection fixed, then see which
    // values of this one still have a variant behind them.
    const constraints = Object.entries(selection).filter(([name]) => name !== axis.name);

    const reachable = new Set<string>();
    for (const variant of variants) {
      const matches = constraints.every(([name, value]) => variant.options[name] === value);
      const own = variant.options[axis.name];
      if (matches && own !== undefined) reachable.add(own);
    }

    result[axis.name] = axis.values.filter((v) => reachable.has(v));
  }

  return result;
}

/** Finds the one variant a complete selection identifies, if any. */
export function matchVariant<T extends { options: OptionSelection }>(
  variants: T[],
  selection: OptionSelection,
): T | null {
  const key = optionKey(selection);
  return variants.find((v) => optionKey(v.options) === key) ?? null;
}
