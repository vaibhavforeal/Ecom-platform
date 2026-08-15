import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CSV_COLUMNS,
  CsvFormatError,
  CsvRecordReader,
  MAX_IMPORT_ROWS,
  REQUIRED_CSV_COLUMNS,
  catalogCsvHeader,
  formatCsvValue,
  parseCatalogCsv,
  parseCsvRecords,
  productToCsvRows,
} from "../src/catalog/csv";
import type { CsvIssue, ExportProduct } from "../src/catalog/csv";

/**
 * The CSV format, on its own.
 *
 * Everything here is pure, so these run without Docker. The database
 * half — matching handles, merging over stored products, and the
 * round-trip no-op — is `apps/console/tests/catalog-csv.integration.test.ts`.
 */

const FIXTURE = join(import.meta.dirname, "fixtures", "catalog-import.csv");

/**
 * Read as UTF-8 TEXT, deliberately. Node does not strip a BOM when
 * decoding, so the string starts with U+FEFF exactly as it would after
 * the route's TextDecoder — which means the parser's own BOM handling is
 * what these tests exercise, not Node's.
 */
function fixture(): string {
  return readFileSync(FIXTURE, "utf8");
}

function issueAt(issues: CsvIssue[], row: number, column: string | null): CsvIssue | undefined {
  return issues.find((i) => i.row === row && i.column === column);
}

describe("the reader", () => {
  it("reads quoted fields, embedded commas, quotes and newlines", () => {
    const records = parseCsvRecords(
      'a,b,c\r\n"x,1","he said ""no""","two\nlines"\r\nplain,,z\r\n',
    );

    expect(records).toEqual([
      ["a", "b", "c"],
      ["x,1", 'he said "no"', "two\nlines"],
      ["plain", "", "z"],
    ]);
  });

  it("does not turn a trailing newline into an extra row", () => {
    expect(parseCsvRecords("a,b\r\n1,2\r\n")).toHaveLength(2);
    expect(parseCsvRecords("a,b\n1,2\n")).toHaveLength(2);
    expect(parseCsvRecords("a,b\r\n1,2")).toHaveLength(2);
  });

  it("keeps a blank line as a row, so row numbers still match the sheet", () => {
    // Excel counts a blank line as a row. Dropping it here would shift
    // every error message after it one line off the merchant's screen.
    const records = parseCsvRecords("a,b\r\n1,2\r\n\r\n3,4\r\n");
    expect(records).toHaveLength(4);
    expect(records[2]).toEqual([""]);
    expect(records[3]).toEqual(["3", "4"]);
  });

  it("gives the same answer however the stream is chopped up", () => {
    const text = 'h1,h2\r\n"a,1","two\nlines"\r\nb,2\r\n';
    const whole = parseCsvRecords(text);

    for (const size of [1, 2, 3, 7, 13]) {
      const reader = new CsvRecordReader();
      const records: string[][] = [];
      for (let i = 0; i < text.length; i += size) {
        records.push(...reader.push(text.slice(i, i + size)));
      }
      records.push(...reader.end());
      expect(records, `chunk size ${size}`).toEqual(whole);
    }
  });

  it("refuses a file that ends inside a quote instead of guessing", () => {
    expect(() => parseCsvRecords('a,b\r\n"unterminated,2\r\n')).toThrow(CsvFormatError);
  });
});

describe("the UTF-8 BOM Excel writes", () => {
  it("is stripped, so the first column is `handle` and not `\\uFEFFhandle`", () => {
    const text = fixture();
    // The fixture really does start with one — if this line ever fails,
    // the fixture has been rewritten and the test below proves nothing.
    expect(text.charCodeAt(0)).toBe(0xfeff);

    const records = parseCsvRecords(text);
    expect(records[0]?.[0]).toBe("handle");
  });

  it("is removed by the READER, not left for a later trim to catch", () => {
    // The header normaliser trims too, and JS does count U+FEFF as
    // whitespace — so this asserts against the reader directly, where
    // the strip actually is. Delete that line and this fails.
    expect(parseCsvRecords("﻿handle,title\r\nx,y\r\n")[0]).toEqual(["handle", "title"]);
  });

  it("leaves the fixture's products readable end to end", () => {
    const { products } = parseCatalogCsv(parseCsvRecords(fixture()));
    expect(products.map((p) => p.handle)).toEqual(["classic-tee", "canvas-bag"]);
  });
});

describe("the fixture — one file, four separate hazards", () => {
  const parsed = parseCatalogCsv(parseCsvRecords(fixture()));

  it("reports the missing required column against the header row", () => {
    // The file has no `title` column at all.
    const issue = issueAt(parsed.issues, 1, "title");
    expect(issue).toBeDefined();
    expect(issue!.message).toBe('The column "title" is required and is not in this file.');
  });

  it("reports the duplicate SKU on the second row that used it", () => {
    const issue = issueAt(parsed.issues, 4, "sku");
    expect(issue).toBeDefined();
    expect(issue!.message).toBe(
      'The SKU "TEE-S" is already used on row 2. Every variant needs its own.',
    );
  });

  it("reports the malformed price rather than importing ₹0", () => {
    const issue = issueAt(parsed.issues, 5, "price");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("not a plain number");
    // And the row produced no variant, so nothing could be written at
    // any price at all.
    expect(parsed.products.find((p) => p.handle === "canvas-bag")!.variants).toEqual([]);
  });

  it("reports exactly those four things and nothing else", () => {
    expect(
      parsed.issues.map((i) => `${i.row}:${i.column}`).sort(),
    ).toEqual(["1:title", "4:sku", "5:null", "5:price"]);
    expect(parsed.rowCount).toBe(4);
  });

  it("still parses the rows it can, so one upload surfaces every problem", () => {
    const tee = parsed.products.find((p) => p.handle === "classic-tee")!;
    expect(tee.variants.map((v) => v.sku)).toEqual(["TEE-S", "TEE-M", "TEE-S"]);
    // 499.00 rupees is 49900 paise, by integer arithmetic on the string.
    expect(tee.variants.map((v) => v.pricePaise)).toEqual([49900, 49900, 49900]);
    expect(tee.variants.map((v) => v.weightGrams)).toEqual([180, 190, 200]);
    expect(tee.optionNames).toEqual(["Size"]);
    expect(tee.variants[1]!.options).toEqual({ Size: "M" });
    // The quoted cell survived its comma.
    expect(tee.summary).toBe("A soft, everyday tee");
    expect(tee.status).toBe("active");
  });
});

describe("what a cell may say", () => {
  const header = [
    "handle",
    "title",
    "sku",
    "price",
    "weight_grams",
    "barcode",
    "compare_at_price",
    "low_stock_at",
    "tags",
    "tax_rate_percent",
    "variant_active",
    "variant_tracks_inventory",
  ];

  function parse(...rows: string[][]) {
    return parseCatalogCsv([header, ...rows]);
  }

  const base = ["tee", "Tee", "TEE-1", "10", "100", "", "", "", "", "", "", ""];

  function withCell(column: string, value: string): string[] {
    const row = [...base];
    row[header.indexOf(column)] = value;
    return row;
  }

  it("reads rupees as integer paise without going through a float", () => {
    const { products } = parse(withCell("price", "₹1,299.10"));
    // 1299.10 → 129910 exactly. parseFloat("1299.10") * 100 is 129909.99…
    expect(products[0]!.variants[0]!.pricePaise).toBe(129910);
  });

  it.each([
    ["", "A price is required — a blank cell is not ₹0."],
    ["free", 'Cannot read "free" as an amount: it is not a plain number'],
    // The whole clause, not a fragment: `toContain("2")` would have
    // matched the merchant's own "1299.999" echoed back and passed
    // against almost any message.
    ["1299.999", "3 decimal places, but a rupee amount has at most 2"],
    ["-50", "An amount cannot be negative."],
  ])("refuses the price %j rather than defaulting it", (value, fragment) => {
    const { products, issues } = parse(withCell("price", value));
    expect(issueAt(issues, 2, "price")?.message).toContain(fragment);
    expect(products[0]!.variants).toEqual([]);
  });

  it("refuses a blank weight, which would quote shipping at zero", () => {
    const { issues } = parse(withCell("weight_grams", ""));
    expect(issueAt(issues, 2, "weight_grams")?.message).toContain("shipping at zero");
  });

  it("refuses a fractional weight rather than rounding it", () => {
    expect(issueAt(parse(withCell("weight_grams", "180.5")).issues, 2, "weight_grams")).toBeDefined();
    // A spreadsheet writing 180 as "180.00" is not an error, though.
    expect(parse(withCell("weight_grams", "180.00")).products[0]!.variants[0]!.weightGrams).toBe(180);
  });

  it("catches a barcode a spreadsheet has turned into scientific notation", () => {
    // Excel does this to any 12+ digit code the moment the file opens,
    // and the original digits are gone. Refusing the row is the only
    // honest option left.
    const { issues } = parse(withCell("barcode", "9.78031E+12"));
    expect(issueAt(issues, 2, "barcode")?.message).toContain("scientific notation");
  });

  it("catches the same damage done to a SKU", () => {
    const { issues, products } = parse(withCell("sku", "1.23457E+12"));
    expect(issueAt(issues, 2, "sku")?.message).toContain("scientific notation");
    // The row produced no variant, so the mangled code cannot be written
    // under any product.
    expect(products[0]!.variants).toEqual([]);
  });

  it("keeps a barcode that merely looks numeric", () => {
    expect(parse(withCell("barcode", "8901234567890")).products[0]!.variants[0]!.barcode).toBe(
      "8901234567890",
    );
  });

  it("splits tags on commas inside one cell and drops repeats", () => {
    expect(parse(withCell("tags", "cotton, shirt ,cotton")).products[0]!.tags).toEqual([
      "cotton",
      "shirt",
    ]);
  });

  it("turns a typed percentage into basis points by string arithmetic", () => {
    // 12.5% → 1250 bps. parseFloat("1.15") * 100 is 114.99999999999999.
    expect(parse(withCell("tax_rate_percent", "12.5")).products[0]!.taxRateBps).toBe(1250);
    expect(parse(withCell("tax_rate_percent", "1.15")).products[0]!.taxRateBps).toBe(115);
    expect(issueAt(parse(withCell("tax_rate_percent", "120")).issues, 2, "tax_rate_percent")).toBeDefined();
  });

  it("reads yes/no in the shapes merchants actually type", () => {
    for (const yes of ["true", "TRUE", "yes", "1"]) {
      expect(parse(withCell("variant_active", yes)).products[0]!.variants[0]!.isActive, yes).toBe(true);
    }
    for (const no of ["false", "No", "0"]) {
      expect(parse(withCell("variant_active", no)).products[0]!.variants[0]!.isActive, no).toBe(false);
    }
    expect(issueAt(parse(withCell("variant_active", "maybe")).issues, 2, "variant_active")).toBeDefined();
  });

  it("leaves variant_active UNDEFINED when the cell is blank, so a switched-off variant stays off", () => {
    // The column is present and the cell is empty. If this came back
    // `true`, `mergeVariant` would take it as a concrete instruction and
    // never consult the stored value — putting a variant the merchant
    // deactivated in the console back on sale, with nothing in the
    // report saying so. Blank states nothing, exactly as it does for
    // every product column.
    const { products, issues } = parse(withCell("variant_active", ""));
    expect(issues).toEqual([]);
    expect(products[0]!.variants[0]!.isActive).toBeUndefined();

    // …and a populated cell still states something.
    expect(parse(withCell("variant_active", "false")).products[0]!.variants[0]!.isActive).toBe(false);
  });

  it("leaves variant_tracks_inventory UNDEFINED when the cell is blank, so tracked variants stay tracked", () => {
    // The column is present and the cell is empty. If this came back
    // `false`, `mergeVariant` would take it as a concrete instruction and
    // never consult the stored value — disabling tracking for a variant
    // the merchant had turned on in the console, with nothing in the
    // report saying so. Blank states nothing, exactly as it does for
    // every product column.
    const { products, issues } = parse(withCell("variant_tracks_inventory", ""));
    expect(issues).toEqual([]);
    expect(products[0]!.variants[0]!.tracksInventory).toBeUndefined();

    // …and a populated cell still states something.
    expect(parse(withCell("variant_tracks_inventory", "true")).products[0]!.variants[0]!.tracksInventory).toBe(true);
  });

  it("distinguishes a column that is absent from one that is blank", () => {
    // Present and blank clears the field; absent leaves it alone. That
    // difference is what stops a five-column CSV wiping every barcode.
    expect(parse(withCell("barcode", "")).products[0]!.variants[0]!.barcode).toBeNull();

    const minimal = parseCatalogCsv([
      ["handle", "title", "sku", "price", "weight_grams"],
      ["tee", "Tee", "TEE-1", "10", "100"],
    ]);
    expect(minimal.products[0]!.variants[0]!.barcode).toBeUndefined();
    expect(minimal.products[0]!.variants[0]!.options).toBeUndefined();
    expect(minimal.products[0]!.tags).toBeUndefined();
  });
});

describe("the handle, and what it groups", () => {
  const header = ["handle", "title", "option1_name", "option1_value", "sku", "price", "weight_grams"];

  it("slugifies, so `Blue Shirt` and `blue-shirt` are one product", () => {
    const { products } = parseCatalogCsv([
      header,
      ["Blue Shirt", "Blue Shirt", "Size", "S", "B-S", "10", "100"],
      ["blue-shirt", "Blue Shirt", "Size", "M", "B-M", "10", "100"],
    ]);

    expect(products).toHaveLength(1);
    expect(products[0]!.handle).toBe("blue-shirt");
    expect(products[0]!.variants).toHaveLength(2);
  });

  it("refuses a handle with nothing sluggable in it", () => {
    const { issues } = parseCatalogCsv([header, ["!!!", "X", "", "", "X-1", "10", "100"]]);
    expect(issueAt(issues, 2, "handle")?.message).toContain("no letters or digits");
  });

  it("takes a product field from the first row that states one", () => {
    // The platforms merchants come from write product columns on the
    // first row of a group and leave them blank after.
    const { products, issues } = parseCatalogCsv([
      ["handle", "title", "vendor", "sku", "price", "weight_grams"],
      ["tee", "Classic Tee", "Acme", "T-S", "10", "100"],
      ["tee", "", "", "T-M", "10", "100"],
    ]);

    expect(issues).toEqual([]);
    expect(products[0]!.title).toBe("Classic Tee");
    expect(products[0]!.vendor).toBe("Acme");
  });

  it("refuses two rows of one product that disagree, rather than picking one", () => {
    const { issues } = parseCatalogCsv([
      ["handle", "title", "sku", "price", "weight_grams"],
      ["tee", "Classic Tee", "T-S", "10", "100"],
      ["tee", "Casual Tee", "T-M", "10", "100"],
    ]);

    const issue = issueAt(issues, 3, "title");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("already gave a different title on row 2");
  });

  it("requires every variant of an optioned product to name every option", () => {
    const { issues } = parseCatalogCsv([
      header,
      ["tee", "Tee", "Size", "S", "T-S", "10", "100"],
      ["tee", "Tee", "Size", "", "T-M", "10", "100"],
    ]);

    expect(issueAt(issues, 3, "option1_value")?.message).toContain('option called "Size"');
  });

  it("refuses a gap in the option columns instead of shifting past it", () => {
    // option2 named while option1 is blank would put the axis at index 0
    // and silently mismatch every variant's values.
    const { issues } = parseCatalogCsv([
      ["handle", "title", "option1_name", "option1_value", "option2_name", "option2_value", "sku", "price", "weight_grams"],
      ["tee", "Tee", "", "", "Colour", "Red", "T-R", "10", "100"],
    ]);

    expect(issueAt(issues, 2, "option1_name")?.message).toContain("Fill the options in order");
  });
});

describe("serialising", () => {
  it("quotes only what has to be quoted", () => {
    expect(formatCsvValue("plain")).toBe("plain");
    expect(formatCsvValue("a,b")).toBe('"a,b"');
    expect(formatCsvValue('say "hi"')).toBe('"say ""hi"""');
    expect(formatCsvValue("two\nlines")).toBe('"two\nlines"');
    expect(formatCsvValue(" padded ")).toBe('" padded "');
  });

  it("defuses a spreadsheet formula, reversibly", () => {
    // `=cmd|'/c calc'!A0` in a product title is command execution in
    // whoever opens the export. CSV quoting does NOT stop it — the
    // spreadsheet strips the quotes before deciding.
    expect(formatCsvValue("=1+1")).toBe("'=1+1");
    expect(formatCsvValue("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(formatCsvValue("-2+3")).toBe("'-2+3");
    // Already starts with an apostrophe: doubled, so unescaping is exact.
    expect(formatCsvValue("'quoted")).toBe("''quoted");
    expect(formatCsvValue("ordinary")).toBe("ordinary");
  });

  it("reads back exactly what it wrote, formula guard included", () => {
    const hostile = "=cmd|'/c calc'!A0";
    const rows = [
      ["handle", "title", "sku", "price", "weight_grams"],
      ["tee", hostile, "TEE-1", "10", "100"],
    ];
    const text = rows.map((r) => r.map(formatCsvValue).join(",")).join("\r\n");

    const { products } = parseCatalogCsv(parseCsvRecords(text));
    expect(products[0]!.title).toBe(hostile);
  });

  it("keeps a foreign file's legitimate leading apostrophe", () => {
    // A file this exporter never wrote (e.g. a Shopify export) may carry a
    // real leading apostrophe. Only strings escapeFormula could have
    // produced get unescaped: '=... '+... '-... '@... ''... '\t... '\r...
    const csv = [
      "handle,title,price,weight_grams,option1_name,option1_value,sku",
      `retro-tee,'90s Tee,499.00,180,Size,M,'0012`,
    ].join("\r\n");

    const parsed = parseCatalogCsv(parseCsvRecords(csv));
    expect(parsed.issues).toEqual([]);
    expect(parsed.products[0]!.title).toBe("'90s Tee");
    expect(parsed.products[0]!.variants[0]!.sku).toBe("'0012");
  });

  it("still unescapes everything its own exporter produces", () => {
    // The existing round-trip tests cover the full path; this pins the
    // boundary cases of the narrower unescape directly.
    const csv = [
      "handle,title,price,weight_grams,option1_name,option1_value,sku",
      `guarded,'=SUM(A1),499.00,180,Size,M,''starts-with-quote`,
    ].join("\r\n");

    const parsed = parseCatalogCsv(parseCsvRecords(csv));
    expect(parsed.products[0]!.title).toBe("=SUM(A1)");
    expect(parsed.products[0]!.variants[0]!.sku).toBe("'starts-with-quote");
  });

  it("writes the header in the documented column order", () => {
    // Spelled out rather than built from CSV_COLUMNS, which is the thing
    // under test: a header derived from the constant agrees with any
    // reordering or rename of it, and this file is a format merchants
    // will have saved and scripted against.
    expect(catalogCsvHeader()).toBe(
      "handle,title,status,summary,description,product_type,vendor,tags,hsn_code," +
        "tax_rate_percent,seo_title,seo_description,seo_noindex," +
        "option1_name,option1_value,option2_name,option2_value,option3_name,option3_value," +
        "sku,barcode,price,compare_at_price,cost,weight_grams,low_stock_at,variant_active,variant_tracks_inventory\r\n",
    );
    expect(CSV_COLUMNS).toHaveLength(28);
    expect(REQUIRED_CSV_COLUMNS).toEqual(["handle", "title", "sku", "price", "weight_grams"]);
  });

  it("writes one row per variant with the product columns repeated", () => {
    const product: ExportProduct = {
      slug: "classic-tee",
      title: "Classic Tee",
      status: "active",
      summary: "A soft, everyday tee",
      description: "<p>Cotton.</p>",
      productType: "Shirt",
      vendor: "Acme",
      tags: ["cotton", "tee"],
      hsnCode: "6109",
      taxRateBps: 1250,
      seo: { title: "Tee", description: null, noindex: false },
      axes: [{ name: "Size", values: ["S", "M"] }],
      variants: [
        {
          sku: "TEE-S",
          barcode: "8901234567890",
          options: { Size: "S" },
          pricePaise: 49900,
          compareAtPaise: 59900,
          costPaise: null,
          weightGrams: 180,
          lowStockAt: 2,
          tracksInventory: true,
          isActive: true,
        },
        {
          sku: "TEE-M",
          barcode: null,
          options: { Size: "M" },
          pricePaise: 49900,
          compareAtPaise: null,
          costPaise: null,
          weightGrams: 190,
          lowStockAt: null,
          tracksInventory: false,
          isActive: false,
        },
      ],
    };

    const rows = productToCsvRows(product);
    expect(rows).toHaveLength(2);

    const records = parseCsvRecords(catalogCsvHeader() + rows.join(""));
    const [header, first, second] = records;
    const at = (record: string[] | undefined, column: string): string | undefined =>
      record?.[header!.indexOf(column)];

    expect(at(first, "handle")).toBe("classic-tee");
    expect(at(second, "handle")).toBe("classic-tee");
    expect(at(first, "title")).toBe("Classic Tee");
    // Rupees, two places, no symbol and no grouping.
    expect(at(first, "price")).toBe("499.00");
    expect(at(first, "compare_at_price")).toBe("599.00");
    expect(at(second, "compare_at_price")).toBe("");
    // 1250 bps → "12.50" percent.
    expect(at(first, "tax_rate_percent")).toBe("12.50");
    expect(at(first, "option1_name")).toBe("Size");
    expect(at(first, "option1_value")).toBe("S");
    expect(at(second, "option1_value")).toBe("M");
    expect(at(first, "option2_name")).toBe("");
    expect(at(first, "tags")).toBe("cotton, tee");
    expect(at(first, "variant_active")).toBe("true");
    expect(at(second, "variant_active")).toBe("false");
    expect(at(first, "variant_tracks_inventory")).toBe("true");
    expect(at(second, "variant_tracks_inventory")).toBe("false");
    expect(at(second, "low_stock_at")).toBe("");
  });

  it("parses its own output back into the same values", () => {
    const product: ExportProduct = {
      slug: "round-trip",
      title: "Round, Trip",
      status: "draft",
      summary: 'He said "hello"',
      description: "<p>Line one</p>\n<p>Line two</p>",
      productType: null,
      vendor: null,
      tags: ["a tag", "another"],
      hsnCode: "6109",
      taxRateBps: 500,
      seo: { title: null, description: "Meta, with a comma", noindex: true },
      axes: [{ name: "Size", values: ["S"] }],
      variants: [
        {
          sku: "RT-1",
          barcode: "8901234567890",
          options: { Size: "S" },
          pricePaise: 129910,
          compareAtPaise: 149900,
          costPaise: 100000,
          weightGrams: 250,
          lowStockAt: 3,
          tracksInventory: true,
          isActive: true,
        },
      ],
    };

    const { products, issues } = parseCatalogCsv(
      parseCsvRecords(catalogCsvHeader() + productToCsvRows(product).join("")),
    );

    expect(issues).toEqual([]);
    const back = products[0]!;
    expect(back.handle).toBe("round-trip");
    expect(back.title).toBe("Round, Trip");
    expect(back.status).toBe("draft");
    expect(back.summary).toBe('He said "hello"');
    expect(back.description).toBe("<p>Line one</p>\n<p>Line two</p>");
    expect(back.tags).toEqual(["a tag", "another"]);
    expect(back.hsnCode).toBe("6109");
    expect(back.taxRateBps).toBe(500);
    expect(back.seoTitle).toBeNull();
    expect(back.seoDescription).toBe("Meta, with a comma");
    expect(back.seoNoindex).toBe(true);
    expect(back.optionNames).toEqual(["Size"]);
    expect(back.variants).toEqual([
      {
        row: 2,
        sku: "RT-1",
        barcode: "8901234567890",
        options: { Size: "S" },
        pricePaise: 129910,
        compareAtPaise: 149900,
        costPaise: 100000,
        weightGrams: 250,
        lowStockAt: 3,
        tracksInventory: true,
        isActive: true,
      },
    ]);
  });
});

describe("caps", () => {
  it("holds the row limit at the documented number", () => {
    // Pinned, not read from the constant under test.
    expect(MAX_IMPORT_ROWS).toBe(5000);
  });

  it("refuses an empty file rather than reporting a clean import of nothing", () => {
    const { issues } = parseCatalogCsv([]);
    expect(issues).toEqual([{ row: 1, column: null, message: "The file is empty." }]);
  });

  it("ignores a column it does not recognise, including tenant_id", () => {
    // The tenant comes from the session. A `tenant_id` column is not
    // honoured, refused or echoed — it simply is not a column.
    const { products, issues } = parseCatalogCsv([
      ["handle", "title", "sku", "price", "weight_grams", "tenant_id", "shopify_id"],
      ["tee", "Tee", "T-1", "10", "100", "00000000-0000-0000-0000-000000000000", "999"],
    ]);

    expect(issues).toEqual([]);
    expect(products).toHaveLength(1);
    expect(JSON.stringify(products[0])).not.toContain("00000000-0000");
  });

  it("refuses the same column twice instead of picking one silently", () => {
    const { issues } = parseCatalogCsv([
      ["handle", "title", "sku", "price", "price", "weight_grams"],
      ["tee", "Tee", "T-1", "10", "20", "100"],
    ]);
    expect(issueAt(issues, 1, "price")?.message).toContain("appears more than once");
  });

  it("refuses more variants under one handle than the console can then save", () => {
    // 200 is `productPayloadSchema`'s variant cap. Importing 201 would
    // create a product the merchant can never save from the console
    // again — the edit form would reject its own payload, and nothing
    // would say why. The numbers are spelled out, not read from the cap.
    const header = ["handle", "title", "sku", "price", "weight_grams"];
    const row = (i: number): string[] => ["big", "Big", `BIG-${i}`, "10", "100"];

    const ok = parseCatalogCsv([header, ...Array.from({ length: 200 }, (_, i) => row(i))]);
    expect(ok.issues).toEqual([]);
    expect(ok.products[0]!.variants).toHaveLength(200);

    const over = parseCatalogCsv([header, ...Array.from({ length: 201 }, (_, i) => row(i))]);
    expect(issueAt(over.issues, 2, "handle")?.message).toContain(
      "has 201 variant rows, and a product can have at most 200",
    );
  });

  it("refuses more values on one option than the console can then save", () => {
    const header = ["handle", "title", "option1_name", "option1_value", "sku", "price", "weight_grams"];
    const row = (i: number): string[] => ["big", "Big", "Size", `V${i}`, `BIG-${i}`, "10", "100"];

    const ok = parseCatalogCsv([header, ...Array.from({ length: 50 }, (_, i) => row(i))]);
    expect(ok.issues).toEqual([]);

    const over = parseCatalogCsv([header, ...Array.from({ length: 51 }, (_, i) => row(i))]);
    expect(issueAt(over.issues, 2, "option1_value")?.message).toBe(
      '"Size" takes 51 different values in this file, and an option can have at most 50.',
    );
  });

  it("caps every merchant-supplied string, because zod does not see this path", () => {
    const long = "x".repeat(300);
    const { issues } = parseCatalogCsv([
      ["handle", "title", "sku", "price", "weight_grams"],
      ["tee", long, "T-1", "10", "100"],
      ["bag", "Bag", long.slice(0, 100), "10", "100"],
    ]);

    expect(issueAt(issues, 2, "title")?.message).toContain("200 characters");
    expect(issueAt(issues, 3, "sku")?.message).toContain("64 characters");
  });
});
