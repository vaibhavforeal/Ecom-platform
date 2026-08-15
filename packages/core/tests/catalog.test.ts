import { describe, expect, it } from "vitest";

import {
  InvalidAmountError,
  MAX_SLUG_LENGTH,
  availableSlug,
  buildCategoryTree,
  catalogPurgeTags,
  catalogTags,
  cartesianCombinations,
  categoryPath,
  discountPercent,
  formatPaise,
  isDescendant,
  matchVariant,
  optionKey,
  paiseToDecimalString,
  parseAmountToPaise,
  reachableValues,
  resolveSlug,
  slugify,
  subtreeIds,
  tenantTagPrefix,
  validateVariantMatrix,
} from "../src/catalog/index";
import type { CategoryNode, OptionAxis } from "../src/catalog/index";
// Imported from the module rather than the `server` barrel: these two are
// pure, but that barrel also pulls in the query layer and therefore the
// postgres driver, which has no business in the unit suite.
import { normalizeSearchQuery, toPrefixTsQuery } from "../src/catalog/search";
import { mergeVariant } from "../src/catalog/bulk";
import type { CsvVariantDraft } from "../src/catalog/csv";
import type { ConsoleVariant } from "../src/catalog/server";

// ───────────────────────────────────────────────────────────────
// Slugs
// ───────────────────────────────────────────────────────────────
describe("slugify", () => {
  it("lowercases and hyphenates a normal title", () => {
    expect(slugify("Classic Cotton Shirt")).toBe("classic-cotton-shirt");
  });

  it("folds Latin diacritics to the form people type", () => {
    expect(slugify("Café Crème")).toBe("cafe-creme");
  });

  it("collapses punctuation and runs of separators", () => {
    expect(slugify("  50% OFF -- Everything!!  ")).toBe("50-off-everything");
  });

  it("preserves non-Latin scripts rather than emptying the slug", () => {
    // A Devanagari title reduced to ASCII is an empty slug, and a store
    // of /item-2, /item-3 is worse than percent-encoded but meaningful
    // URLs. Both characters below are letters, so both survive.
    const slug = slugify("साड़ी");
    expect(slug).not.toBe("item");
    expect(slug).toContain("स");
  });

  it("falls back when nothing survives", () => {
    expect(slugify("!!!___!!!")).toBe("item");
    expect(slugify("###", { fallback: "product" })).toBe("product");
  });

  it("truncates long titles at a word boundary", () => {
    const long = Array.from({ length: 30 }, () => "verylongword").join(" ");
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
    // Cut at a boundary, so no partial trailing word.
    expect(slug.split("-").every((part) => part === "verylongword")).toBe(true);
  });

  it("keeps a single over-long word rather than returning the fallback", () => {
    const slug = slugify("a".repeat(200));
    expect(slug.length).toBe(MAX_SLUG_LENGTH);
  });
});

describe("availableSlug", () => {
  it("returns the desired slug when it is free", async () => {
    expect(await availableSlug("shirt", async () => false)).toBe("shirt");
  });

  it("suffixes from 2 upward on collision", async () => {
    const taken = new Set(["shirt", "shirt-2", "shirt-3"]);
    expect(await availableSlug("shirt", async (s) => taken.has(s))).toBe("shirt-4");
  });

  it("does not hand out a reserved storefront path", async () => {
    // /checkout must remain the checkout, whatever a merchant names a
    // product. Reserving late means breaking whoever already took it.
    const slug = await availableSlug("checkout", async () => false);
    expect(slug).not.toBe("checkout");
    expect(slug).toBe("checkout-item");
  });

  it("keeps the numbered slug within the length limit", async () => {
    const base = "a".repeat(MAX_SLUG_LENGTH);
    const slug = await availableSlug(base, async (s) => s === base);
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith("-2")).toBe(true);
  });

  it("gives up rather than looping forever", async () => {
    await expect(availableSlug("shirt", async () => true, { maxAttempts: 5 })).rejects.toThrow(
      /Could not find a free slug/,
    );
  });
});

describe("resolveSlug", () => {
  const canonicalFor = (_type: string, id: string) => (id === "p1" ? "new-shirt" : null);

  it("renders a canonical slug", () => {
    expect(
      resolveSlug(
        { slug: "new-shirt", entityType: "product", entityId: "p1", isCanonical: true },
        canonicalFor,
      ),
    ).toEqual({ action: "render", entityType: "product", entityId: "p1" });
  });

  it("permanently redirects a superseded slug to the canonical one", () => {
    // Permanent, never temporary: a 302 does not transfer the ranking
    // signal, which is the entire reason slug history is kept. The
    // status number is the transport's choice — Next emits 308, which
    // Google treats as equivalent to 301.
    expect(
      resolveSlug(
        { slug: "old-shirt", entityType: "product", entityId: "p1", isCanonical: false },
        canonicalFor,
      ),
    ).toEqual({ action: "redirect", to: "new-shirt", permanent: true });
  });

  it("404s a historical slug whose entity is gone", () => {
    expect(
      resolveSlug(
        { slug: "old-thing", entityType: "product", entityId: "deleted", isCanonical: false },
        canonicalFor,
      ),
    ).toEqual({ action: "notFound" });
  });

  it("404s an unknown slug", () => {
    expect(resolveSlug(null, canonicalFor)).toEqual({ action: "notFound" });
  });
});

// ───────────────────────────────────────────────────────────────
// Option matrices
// ───────────────────────────────────────────────────────────────
const SIZE_COLOUR: OptionAxis[] = [
  { name: "Size", values: ["S", "M"] },
  { name: "Colour", values: ["Red", "Blue"] },
];

describe("optionKey", () => {
  it("is order-independent", () => {
    expect(optionKey({ Size: "M", Colour: "Red" })).toBe(optionKey({ Colour: "Red", Size: "M" }));
  });

  it("does not collide when values contain separators", () => {
    // '1/2 in' and 'Red: Matte' are real option values. A space or colon
    // separator would let two different selections serialise identically.
    expect(optionKey({ Drive: '1/2 in', Finish: "Matte" })).not.toBe(
      optionKey({ Drive: '1/2', Finish: "in Matte" }),
    );
    expect(optionKey({ A: "b", C: "d" })).not.toBe(optionKey({ A: "b C d" }));
  });
});

describe("cartesianCombinations", () => {
  it("produces every combination in display order", () => {
    expect(cartesianCombinations(SIZE_COLOUR)).toEqual([
      { Size: "S", Colour: "Red" },
      { Size: "S", Colour: "Blue" },
      { Size: "M", Colour: "Red" },
      { Size: "M", Colour: "Blue" },
    ]);
  });

  it("returns one empty selection for a product with no axes", () => {
    expect(cartesianCombinations([])).toEqual([{}]);
  });
});

describe("validateVariantMatrix", () => {
  it("accepts a complete, consistent matrix", () => {
    const variants = cartesianCombinations(SIZE_COLOUR).map((options, i) => ({
      sku: `SKU-${i}`,
      options,
    }));
    expect(validateVariantMatrix(SIZE_COLOUR, variants)).toEqual([]);
  });

  it("flags a variant that omits an axis", () => {
    // The quiet failure: not a constraint violation, just a PDP where
    // some selections never resolve to a variant.
    const issues = validateVariantMatrix(SIZE_COLOUR, [{ sku: "A", options: { Size: "M" } }]);
    expect(issues.map((i) => i.code)).toContain("missing_axis");
  });

  it("flags an axis the product does not declare", () => {
    const issues = validateVariantMatrix(SIZE_COLOUR, [
      { sku: "A", options: { Size: "M", Colour: "Red", Length: "32" } },
    ]);
    expect(issues.map((i) => i.code)).toContain("unknown_axis");
  });

  it("flags a value outside the declared set", () => {
    const issues = validateVariantMatrix(SIZE_COLOUR, [
      { sku: "A", options: { Size: "XXL", Colour: "Red" } },
    ]);
    expect(issues.map((i) => i.code)).toContain("unknown_value");
  });

  it("flags two variants at the same combination", () => {
    const issues = validateVariantMatrix(SIZE_COLOUR, [
      { sku: "A", options: { Size: "M", Colour: "Red" } },
      { sku: "B", options: { Colour: "Red", Size: "M" } },
    ]);
    const dupes = issues.filter((i) => i.code === "duplicate_combination");
    expect(dupes).toHaveLength(1);
    expect(dupes[0]?.message).toContain("A");
    expect(dupes[0]?.message).toContain("B");
  });

  it("reports every problem at once, not just the first", () => {
    // This drives a form. One error per save makes a 40-row import
    // unusable.
    const issues = validateVariantMatrix(SIZE_COLOUR, [
      { sku: "A", options: { Size: "XXL" } },
      { sku: "B", options: { Size: "XXL" } },
    ]);
    expect(new Set(issues.map((i) => i.code)).size).toBeGreaterThan(1);
  });

  it("allows exactly one option-less variant when no axes are declared", () => {
    expect(validateVariantMatrix([], [{ sku: "ONLY", options: {} }])).toEqual([]);
  });

  it("rejects several variants with nothing to tell them apart", () => {
    const issues = validateVariantMatrix([], [
      { sku: "A", options: {} },
      { sku: "B", options: {} },
    ]);
    expect(issues.map((i) => i.code)).toContain("multiple_variants_without_options");
  });

  it("flags duplicate and empty axes", () => {
    const issues = validateVariantMatrix(
      [
        { name: "Size", values: ["S"] },
        { name: "Size", values: [] },
      ],
      [],
    );
    expect(issues.map((i) => i.code)).toContain("duplicate_axis");
    expect(issues.map((i) => i.code)).toContain("empty_axis");
  });
});

describe("reachableValues", () => {
  // A sparse matrix: Blue comes in S only.
  const variants = [
    { options: { Size: "S", Colour: "Red" } },
    { options: { Size: "S", Colour: "Blue" } },
    { options: { Size: "M", Colour: "Red" } },
  ];

  it("narrows the other axis once one is chosen", () => {
    expect(reachableValues(SIZE_COLOUR, variants, { Size: "M" })).toEqual({
      Size: ["S", "M"],
      Colour: ["Red"],
    });
  });

  it("keeps every value reachable when nothing is selected", () => {
    expect(reachableValues(SIZE_COLOUR, variants, {})).toEqual({
      Size: ["S", "M"],
      Colour: ["Red", "Blue"],
    });
  });

  it("does not constrain an axis by its own current value", () => {
    // Size must still offer M while Size=S is selected, or the shopper
    // can never change their mind.
    expect(reachableValues(SIZE_COLOUR, variants, { Size: "S" }).Size).toEqual(["S", "M"]);
  });
});

describe("matchVariant", () => {
  const variants = [
    { sku: "A", options: { Size: "S", Colour: "Red" } },
    { sku: "B", options: { Size: "M", Colour: "Red" } },
  ];

  it("finds the variant regardless of key order", () => {
    expect(matchVariant(variants, { Colour: "Red", Size: "M" })?.sku).toBe("B");
  });

  it("returns null for a combination with no variant", () => {
    expect(matchVariant(variants, { Size: "M", Colour: "Blue" })).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────
// Money
// ───────────────────────────────────────────────────────────────
describe("parseAmountToPaise", () => {
  it("parses plain and grouped rupee amounts", () => {
    expect(parseAmountToPaise("1299")).toBe(129900);
    expect(parseAmountToPaise("1,299.00")).toBe(129900);
    expect(parseAmountToPaise("₹1,299.50")).toBe(129950);
    expect(parseAmountToPaise("  1299.5 ")).toBe(129950);
  });

  it("never rounds through a float", () => {
    // The classic bug: Math.round(parseFloat(x) * 100) is right for most
    // inputs and silently off by a paisa for some. These are values
    // where the binary representation is not exact.
    expect(parseAmountToPaise("1.10")).toBe(110);
    expect(parseAmountToPaise("8.20")).toBe(820);
    expect(parseAmountToPaise("1099.35")).toBe(109935);
    expect(parseAmountToPaise("16.08")).toBe(1608);
  });

  it("refuses more precision than a rupee amount has", () => {
    // Storing ₹1300.00 for a typed 1299.999 is a price change the
    // merchant did not make and will not notice.
    expect(() => parseAmountToPaise("1299.999")).toThrow(InvalidAmountError);
  });

  it("rejects junk rather than guessing", () => {
    for (const bad of ["", "   ", "abc", "12.3.4", "1e5", "--5"]) {
      expect(() => parseAmountToPaise(bad), bad).toThrow(InvalidAmountError);
    }
  });

  it("handles negatives for adjustments", () => {
    expect(parseAmountToPaise("-250.50")).toBe(-25050);
  });
});

describe("formatPaise / paiseToDecimalString", () => {
  it("renders Indian grouping with two decimals", () => {
    // en-IN groups in lakhs: 12,99,900 not 1,299,900.
    const formatted = formatPaise(129990000);
    expect(formatted).toContain("12,99,900.00");
  });

  it("always shows two decimals, including on round amounts", () => {
    expect(formatPaise(129900)).toContain("1,299.00");
  });

  it("emits a bare decimal for structured data and CSV", () => {
    // schema.org Offer.price with a ₹ or a comma is silently dropped by
    // Google, and the rich result just stops appearing.
    expect(paiseToDecimalString(129900)).toBe("1299.00");
    expect(paiseToDecimalString(5)).toBe("0.05");
    expect(paiseToDecimalString(0)).toBe("0.00");
    expect(paiseToDecimalString(-25050)).toBe("-250.50");
  });

  it("round-trips through the parser", () => {
    for (const paise of [0, 5, 99, 100, 129900, 999999999]) {
      expect(parseAmountToPaise(paiseToDecimalString(paise))).toBe(paise);
    }
  });
});

describe("discountPercent", () => {
  it("rounds down so the saving is never overstated", () => {
    expect(discountPercent(100000, 129900)).toBe(23); // 23.01%
  });

  it("returns null when there is no genuine discount", () => {
    expect(discountPercent(129900, null)).toBeNull();
    expect(discountPercent(129900, 129900)).toBeNull();
    expect(discountPercent(129900, 99900)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────
// Search
// ───────────────────────────────────────────────────────────────
describe("normalizeSearchQuery", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeSearchQuery("  red   shirt ")).toBe("red shirt");
  });

  it("returns null for anything that should not run a search", () => {
    for (const empty of ["", "   ", null, undefined]) {
      expect(normalizeSearchQuery(empty as string | null)).toBeNull();
    }
  });

  it("caps absurdly long input", () => {
    expect((normalizeSearchQuery("a".repeat(500)) ?? "").length).toBeLessThanOrEqual(128);
  });
});

describe("toPrefixTsQuery", () => {
  it("prefix-matches only the last term", () => {
    expect(toPrefixTsQuery("red shi")).toBe("red & shi:*");
  });

  it("strips characters that would be tsquery operators", () => {
    // to_tsquery throws a syntax error on a stray & — a 500 on the
    // search page from someone typing "shirts & ties".
    expect(toPrefixTsQuery("shirts & ties")).toBe("shirts & ties:*");
    expect(toPrefixTsQuery("a | b ! c")).toBe("a & b & c:*");
  });

  it("returns null when no terms survive", () => {
    expect(toPrefixTsQuery("!!! &&& ")).toBeNull();
    expect(toPrefixTsQuery("")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────
// Category trees
// ───────────────────────────────────────────────────────────────
const NODES: CategoryNode[] = [
  { id: "apparel", parentId: null, title: "Apparel", position: 0 },
  { id: "shirts", parentId: "apparel", title: "Shirts", position: 0 },
  { id: "formal", parentId: "shirts", title: "Formal", position: 1 },
  { id: "casual", parentId: "shirts", title: "Casual", position: 0 },
  { id: "home", parentId: null, title: "Home", position: 1 },
];

describe("buildCategoryTree", () => {
  it("nests and sorts by position", () => {
    const tree = buildCategoryTree(NODES);
    expect(tree.map((n) => n.id)).toEqual(["apparel", "home"]);
    expect(tree[0]?.children[0]?.children.map((n) => n.id)).toEqual(["casual", "formal"]);
  });

  it("records depth", () => {
    const tree = buildCategoryTree(NODES);
    expect(tree[0]?.depth).toBe(0);
    expect(tree[0]?.children[0]?.depth).toBe(1);
  });

  it("promotes an orphan to a root rather than dropping its subtree", () => {
    // The parent may simply be hidden and filtered out upstream. Losing
    // the child would remove a whole branch from the navigation.
    const orphaned = NODES.filter((n) => n.id !== "apparel");
    const tree = buildCategoryTree(orphaned);
    expect(tree.map((n) => n.id).sort()).toEqual(["home", "shirts"]);
  });
});

describe("categoryPath", () => {
  it("returns the root-to-node path for breadcrumbs", () => {
    expect(categoryPath(NODES, "formal").map((n) => n.id)).toEqual(["apparel", "shirts", "formal"]);
  });

  it("is empty for an unknown id", () => {
    expect(categoryPath(NODES, "nope")).toEqual([]);
  });
});

describe("isDescendant", () => {
  it("detects a node inside a subtree", () => {
    expect(isDescendant(NODES, "apparel", "formal")).toBe(true);
  });

  it("treats a node as its own descendant", () => {
    expect(isDescendant(NODES, "shirts", "shirts")).toBe(true);
  });

  it("returns false across branches", () => {
    expect(isDescendant(NODES, "home", "formal")).toBe(false);
  });

  it("terminates on a cyclic tree", () => {
    // Should be impossible, but a render path must not hang if it is not.
    const cyclic: CategoryNode[] = [
      { id: "a", parentId: "b", title: "A", position: 0 },
      { id: "b", parentId: "a", title: "B", position: 0 },
    ];
    expect(isDescendant(cyclic, "a", "zzz")).toBe(false);
  });
});

describe("subtreeIds", () => {
  it("includes the root and every descendant", () => {
    expect(subtreeIds(NODES, "apparel").sort()).toEqual(
      ["apparel", "casual", "formal", "shirts"].sort(),
    );
  });

  it("is just the node for a leaf", () => {
    expect(subtreeIds(NODES, "formal")).toEqual(["formal"]);
  });
});

describe("storefront cache tags", () => {
  /**
   * These strings are a CONTRACT between two processes. The storefront
   * stores cache entries under them and the console names them to purge
   * them, and a mismatch purges nothing at all — silently, with no error
   * and nothing in a log. So they are written out here in full rather
   * than built from the functions under test, which would make this pass
   * for any scheme at all.
   */
  const TENANT = "11111111-2222-3333-4444-555555555555";
  const PRODUCT = "99999999-8888-7777-6666-555555555555";

  it("builds the exact tag strings the storefront caches under", () => {
    expect(catalogTags.all(TENANT)).toBe("t:11111111-2222-3333-4444-555555555555:catalog");
    expect(catalogTags.slugs(TENANT)).toBe("t:11111111-2222-3333-4444-555555555555:slugs");
    expect(catalogTags.categories(TENANT)).toBe(
      "t:11111111-2222-3333-4444-555555555555:categories",
    );
    expect(catalogTags.product(TENANT, PRODUCT)).toBe(
      "t:11111111-2222-3333-4444-555555555555:product:99999999-8888-7777-6666-555555555555",
    );
  });

  it("prefixes every tag with the tenant, which is what bounds a purge", () => {
    // The purge endpoint refuses any tag not starting with this, so the
    // prefix has to be a genuine prefix of all four.
    expect(tenantTagPrefix(TENANT)).toBe("t:11111111-2222-3333-4444-555555555555:");

    for (const tag of catalogPurgeTags(TENANT, [PRODUCT])) {
      expect(tag.startsWith(tenantTagPrefix(TENANT)), tag).toBe(true);
    }

    // And it does not match a DIFFERENT tenant whose id merely starts
    // the same way — the trailing colon is load-bearing.
    const sibling = TENANT + "-extra";
    expect(catalogTags.all(sibling).startsWith(tenantTagPrefix(TENANT))).toBe(false);
  });

  it("covers the whole write, product tags last", () => {
    expect(catalogPurgeTags(TENANT, [PRODUCT])).toEqual([
      "t:11111111-2222-3333-4444-555555555555:catalog",
      "t:11111111-2222-3333-4444-555555555555:slugs",
      "t:11111111-2222-3333-4444-555555555555:categories",
      "t:11111111-2222-3333-4444-555555555555:product:99999999-8888-7777-6666-555555555555",
    ]);
  });

  it("drops to the tenant-wide set when no product is named", () => {
    // What a taxonomy write and a bulk import send. `:catalog` is on
    // every cached entry, so this is still a complete purge.
    expect(catalogPurgeTags(TENANT)).toEqual([
      "t:11111111-2222-3333-4444-555555555555:catalog",
      "t:11111111-2222-3333-4444-555555555555:slugs",
      "t:11111111-2222-3333-4444-555555555555:categories",
    ]);
  });
});

// ───────────────────────────────────────────────────────────────
// Bulk merge
// ───────────────────────────────────────────────────────────────
describe("mergeVariant", () => {
  it("preserves stored tracksInventory: true when the CSV cell is blank", () => {
    // The parse step leaves tracksInventory undefined for a blank cell.
    // This test asserts the MERGE step preserves the stored value rather
    // than defaulting to false, which is what a regression to
    // `row.tracksInventory ?? false` (without the `existing` term) would do.
    const stored: ConsoleVariant = {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      sku: "TEST-1",
      barcode: null,
      options: {},
      pricePaise: 100000,
      compareAtPaise: null,
      costPaise: null,
      currency: "INR",
      weightGrams: 100,
      lowStockAt: null,
      tracksInventory: true,
      imageMediaId: null,
      isActive: true,
    };

    const row: CsvVariantDraft = {
      row: 2,
      sku: "TEST-1",
      options: {},
      pricePaise: 120000,
      weightGrams: 100,
      // tracksInventory is UNDEFINED — the parse step for a blank cell
    };

    const merged = mergeVariant(row, stored);
    expect(merged.tracksInventory).toBe(true);
  });

  it("defaults tracksInventory to false when no stored variant exists and the CSV cell is blank", () => {
    // A new variant with no stored value and undefined in the CSV should
    // default to false (untracked).
    const row: CsvVariantDraft = {
      row: 2,
      sku: "NEW-1",
      options: {},
      pricePaise: 100000,
      weightGrams: 100,
      // tracksInventory is UNDEFINED
    };

    const merged = mergeVariant(row, null);
    expect(merged.tracksInventory).toBe(false);
  });
});
