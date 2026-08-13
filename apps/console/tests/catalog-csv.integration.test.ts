import { createHash, randomUUID } from "node:crypto";

import { closeRedis } from "@platform/core";
import { CSV_COLUMNS, MAX_IMPORT_ROWS } from "@platform/core/catalog";
import type { ImportReport } from "@platform/core/catalog";
import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Bulk CSV import and export against real PostgreSQL, with RLS live.
 *
 * The headline property is the ROUND TRIP: a catalog exported and
 * re-imported unchanged must be a no-op. Not "an idempotent rewrite" —
 * an actual no-op, with no audit row, no `updated_at` bump and the same
 * variant ids afterwards. A merchant who exports their catalog to look
 * at it in a spreadsheet, changes nothing, and uploads it again must not
 * find their entire history rewritten.
 *
 * Reads back through a MIGRATOR connection, which is not subject to RLS,
 * so "nothing was written for tenant B" is a claim about the table
 * rather than about what tenant B's own context happens to show.
 */

let sessionToken: string | undefined;

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "console_session" && sessionToken ? { name, value: sessionToken } : undefined,
    }),
  headers: () => Promise.resolve(new Headers()),
}));

const { POST: createProductRoute } = await import("../src/app/api/products/route");
const { POST: importRoute } = await import("../src/app/api/products/import/route");
const { GET: exportRoute } = await import("../src/app/api/products/export/route");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantA: string;
let tenantB: string;
let ownerToken: string;
let cashierToken: string;

async function makeTenant(): Promise<string> {
  const slug = "csv-" + randomUUID().slice(0, 10);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"csv-" + randomUUID().slice(0, 8)}, 'CSV test plan')
    RETURNING id`;
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  return tenant!.id;
}

async function makeSession(tenantId: string, role: string): Promise<string> {
  const userId = randomUUID();
  const phone = "+9198" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userId}, ${phone}, 'CSV test')`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, role, accepted_at)
    VALUES (${tenantId}, ${userId}, ${role}, now())`;

  const token = randomUUID() + randomUUID();
  await admin`
    INSERT INTO sessions (id, token_hash, user_id, tenant_id, expires_at, idle_expires_at)
    VALUES (${randomUUID()}, ${createHash("sha256").update(token).digest("hex")},
            ${userId}, ${tenantId}, now() + interval '1 day', now() + interval '1 day')`;
  return token;
}

async function createProduct(body: Record<string, unknown>): Promise<string> {
  const response = await createProductRoute(
    new Request("http://console.test/api/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const data = (await response.json()) as { productId?: string };
  expect(response.status, JSON.stringify(data)).toBe(201);
  return data.productId!;
}

/**
 * `Response.text()` performs a UTF-8 decode, which STRIPS a leading BOM
 * — so reading the export that way would quietly hide whether one was
 * written and would feed the importer a file Excel never produces. These
 * tests take the bytes and decode with `ignoreBOM`, so what goes back
 * into the importer is what the merchant's browser downloaded.
 */
async function exportCsv(): Promise<{ status: number; text: string; bytes: Uint8Array }> {
  const response = await exportRoute();
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    bytes,
    text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
  };
}

async function importCsv(
  csv: string,
  opts: { commit?: boolean } = {},
): Promise<{ status: number; report: ImportReport | null; body: Record<string, unknown> }> {
  const url = `http://console.test/api/products/import${opts.commit ? "?commit=true" : ""}`;
  const response = await importRoute(
    new Request(url, { method: "POST", headers: { "content-type": "text/csv" }, body: csv }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, report: (body.report as ImportReport) ?? null, body };
}

/** Rewrites one cell of the first data row, leaving everything else byte for byte. */
function editCell(csv: string, column: string, value: string, matchRow: string): string {
  const index = CSV_COLUMNS.indexOf(column as (typeof CSV_COLUMNS)[number]);
  expect(index).toBeGreaterThanOrEqual(0);

  return csv
    .split("\r\n")
    .map((line) => {
      if (!line.includes(matchRow)) return line;
      const cells = splitSimple(line);
      if (cells.length !== CSV_COLUMNS.length) return line;
      cells[index] = value;
      return cells.join(",");
    })
    .join("\r\n");
}

/** Only used on rows the test itself wrote, which carry no quoted commas. */
function splitSimple(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char === '"' ? '"' : char;
  }
  cells.push(cell);
  return cells;
}

type Snapshot = {
  products: { id: string; updated_at: string; title: string }[];
  variants: { id: string; sku: string; price_paise: string; updated_at: string }[];
  audits: number;
};

async function snapshot(tenantId: string): Promise<Snapshot> {
  const products = await admin<{ id: string; updated_at: string; title: string }[]>`
    SELECT id, updated_at::text, title FROM products
    WHERE tenant_id = ${tenantId} ORDER BY id`;
  const variants = await admin<
    { id: string; sku: string; price_paise: string; updated_at: string }[]
  >`SELECT id, sku, price_paise::text, updated_at::text FROM product_variants
    WHERE tenant_id = ${tenantId} ORDER BY sku`;
  const [audit] = await admin<{ count: string }[]>`
    SELECT count(*)::int AS count FROM audit_log WHERE tenant_id = ${tenantId}`;
  return { products, variants, audits: Number(audit!.count) };
}

beforeAll(async () => {
  // A committed import purges, and the repo `.env` this config loads
  // points the origin at `http://localhost:3000` — so without this
  // every committed file in this suite POSTs the REAL internal secret
  // at whatever holds port 3000 on the machine. Nothing here asserts a
  // purge; that contract, including the no-op case below, lives in
  // `cache-purge.integration.test.ts` against a stub storefront it
  // owns. Unset, `purgeStorefrontCache` logs `cache.purge_unconfigured`
  // and returns without a request.
  delete process.env.STOREFRONT_INTERNAL_ORIGIN;

  tenantA = await makeTenant();
  tenantB = await makeTenant();
  ownerToken = await makeSession(tenantA, "owner");
  // catalog:read but NOT catalog:write — see ROLE_PERMISSIONS.
  cashierToken = await makeSession(tenantA, "cashier");
});

afterEach(() => {
  sessionToken = undefined;
});

afterAll(async () => {
  await closeRedis();
  await admin.end();
  await closeConnections();
});

describe("authentication and authorisation", () => {
  it("refuses an unauthenticated import and an unauthenticated export", async () => {
    expect((await importCsv("handle,title,sku,price,weight_grams\r\nx,X,X-1,10,100\r\n")).status).toBe(401);
    expect((await exportCsv()).status).toBe(401);
  });

  it("refuses an import from an actor without catalog:write", async () => {
    sessionToken = cashierToken;
    const { status, body } = await importCsv(
      "handle,title,sku,price,weight_grams\r\nnope,Nope,NOPE-1,10,100\r\n",
      { commit: true },
    );

    expect(status).toBe(403);
    expect(body).toMatchObject({ error: { code: "forbidden" } });

    const [row] = await admin<{ count: string }[]>`
      SELECT count(*)::int AS count FROM products
      WHERE tenant_id = ${tenantA} AND title = 'Nope'`;
    expect(Number(row!.count)).toBe(0);
  });

  it("lets a read-only actor export, which is their own catalog anyway", async () => {
    sessionToken = cashierToken;
    const { status, text } = await exportCsv();
    expect(status).toBe(200);
    expect(text).toContain("handle,title,status");
  });
});

describe("the round trip — export, re-import, and nothing happens", () => {
  /** Its own tenant, so counts cannot drift with the other suites. */
  let tenant: string;
  let token: string;

  beforeAll(async () => {
    tenant = await makeTenant();
    token = await makeSession(tenant, "owner");
    sessionToken = token;

    // Deliberately awkward: a comma and quotes in text, HTML the
    // sanitiser rewrites, an option value no variant uses, an archived
    // product, a barcode, a compare-at price and a tax rate.
    await createProduct({
      title: "Classic, Cotton Shirt",
      status: "active",
      summary: 'The one they call "the good one"',
      description:
        '<p>Machine wash <strong>cold</strong>.</p><a href="https://example.test/care">Care guide</a>',
      productType: "Shirt",
      vendor: "Acme & Co",
      tags: ["cotton", "everyday"],
      hsnCode: "6205",
      taxRatePercent: "12.5",
      seo: { title: "Cotton Shirt", description: "A shirt, plainly.", noindex: true },
      // L is declared and never stocked. A rebuild-from-rows importer
      // would silently drop it and break this test.
      axes: [{ name: "Size", values: ["S", "M", "L"] }],
      variants: [
        {
          sku: "RT-S",
          barcode: "8901234567890",
          options: { Size: "S" },
          price: "1299.10",
          compareAt: "1499",
          weightGrams: 240,
          lowStockAt: 3,
        },
        {
          sku: "RT-M",
          options: { Size: "M" },
          price: "1299.10",
          weightGrams: 250,
          isActive: false,
        },
      ],
    });

    await createProduct({
      title: "Canvas Bag",
      status: "archived",
      variants: [{ sku: "RT-BAG", price: "899", weightGrams: 400 }],
    });

    sessionToken = undefined;
  });

  it("exports a BOM, the documented header, and one row per variant", async () => {
    sessionToken = token;
    const { status, text, bytes } = await exportCsv();

    expect(status).toBe(200);
    // Excel on Windows reads a BOM-less CSV as the system codepage, so
    // a Devanagari or Tamil product name opens as mojibake. Asserted on
    // the BYTES, because decoding would strip it.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // Spelled out rather than built from `CSV_COLUMNS`. A header derived
    // from the constant agrees with any reordering or rename of it, so
    // it cannot fail — and this is a file merchants save and script
    // against. Same reason, same wording, as the unit test in
    // `packages/core/tests/catalog-csv.test.ts`.
    expect(text.slice(1)).toMatch(
      /^handle,title,status,summary,description,product_type,vendor,tags,hsn_code,tax_rate_percent,seo_title,seo_description,seo_noindex,option1_name,option1_value,option2_name,option2_value,option3_name,option3_value,sku,barcode,price,compare_at_price,cost,weight_grams,low_stock_at,variant_active\r\n/,
    );

    // Three variants across two products, and no header repetition.
    const lines = text.trimEnd().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.includes("RT-S"))).toHaveLength(1);
    // Drafts and archived products included — this is a backup, not a
    // storefront listing.
    expect(lines.some((l) => l.startsWith("canvas-bag,Canvas Bag,archived"))).toBe(true);
  });

  it("re-imports as a pure no-op: nothing created, nothing updated, nothing touched", async () => {
    sessionToken = token;

    const before = await snapshot(tenant);
    expect(before.products).toHaveLength(2);
    expect(before.variants).toHaveLength(3);

    const { text } = await exportCsv();

    // ── Dry run ──
    const dry = await importCsv(text);
    expect(dry.status).toBe(200);
    expect(dry.report!.issues).toEqual([]);
    expect(dry.report!.committed).toBe(false);
    expect(dry.report!.rows).toBe(3);
    expect({
      created: dry.report!.created,
      updated: dry.report!.updated,
      skipped: dry.report!.skipped,
    }).toEqual({ created: 0, updated: 0, skipped: 2 });

    // ── Commit ──
    const committed = await importCsv(text, { commit: true });
    expect(committed.status).toBe(200);
    expect(committed.report!.committed).toBe(true);
    expect({
      created: committed.report!.created,
      updated: committed.report!.updated,
      skipped: committed.report!.skipped,
    }).toEqual({ created: 0, updated: 0, skipped: 2 });

    // The point of the whole exercise. Same rows, same ids, same
    // timestamps, and not one new audit entry — because the importer
    // decided there was nothing to write rather than writing the same
    // values again.
    const after = await snapshot(tenant);
    expect(after).toEqual(before);
  });

  it("keeps an option value that no variant uses", async () => {
    sessionToken = token;
    await importCsv((await exportCsv()).text, { commit: true });

    const values = await admin<{ value: string }[]>`
      SELECT v.value FROM product_option_values v
      JOIN product_options o ON o.id = v.option_id
      WHERE o.tenant_id = ${tenant} ORDER BY v.position`;

    // "L" is declared on the product and stocked by nobody. Rebuilding
    // the axes from the file's rows would drop it silently.
    expect(values.map((v) => v.value)).toEqual(["S", "M", "L"]);
  });

  it("round-trips a description through the sanitiser without drift", async () => {
    sessionToken = token;
    const [before] = await admin<{ description: string }[]>`
      SELECT description FROM products WHERE tenant_id = ${tenant} AND title LIKE 'Classic%'`;

    await importCsv((await exportCsv()).text, { commit: true });

    const [after] = await admin<{ description: string }[]>`
      SELECT description FROM products WHERE tenant_id = ${tenant} AND title LIKE 'Classic%'`;

    // The stored value is already sanitised; re-importing it sanitises
    // it again. Anything non-idempotent in there — a rel attribute
    // appended twice, an entity re-escaped — would show up here as a
    // product that is "changed" on every single import, forever.
    expect(after!.description).toBe(before!.description);
    expect(before!.description).toContain('rel="nofollow noopener"');
  });
});

describe("what an import actually changes", () => {
  let tenant: string;
  let token: string;

  beforeAll(async () => {
    tenant = await makeTenant();
    token = await makeSession(tenant, "owner");
    sessionToken = token;
    await createProduct({
      title: "Editable Shirt",
      status: "active",
      summary: "Before",
      axes: [{ name: "Size", values: ["S", "M"] }],
      variants: [
        { sku: "ED-S", barcode: "111222333", options: { Size: "S" }, price: "500", weightGrams: 100 },
        { sku: "ED-M", barcode: "444555666", options: { Size: "M" }, price: "500", weightGrams: 110 },
      ],
    });
    sessionToken = undefined;
  });

  it("reports an edit as an update, and writes nothing on the dry run", async () => {
    sessionToken = token;
    const original = (await exportCsv()).text;
    const edited = editCell(original, "price", "650.00", "ED-S");

    const dry = await importCsv(edited);
    expect(dry.report!.updated).toBe(1);
    expect(dry.report!.skipped).toBe(0);
    expect(dry.report!.committed).toBe(false);

    // A dry run is a dry run: the transaction it did all that work in
    // was rolled back.
    const [unchanged] = await admin<{ price_paise: string }[]>`
      SELECT price_paise::text FROM product_variants
      WHERE tenant_id = ${tenant} AND sku = 'ED-S'`;
    expect(Number(unchanged!.price_paise)).toBe(50000);

    const committed = await importCsv(edited, { commit: true });
    expect(committed.report!.committed).toBe(true);
    expect(committed.report!.updated).toBe(1);

    const [repriced] = await admin<{ price_paise: string; id: string }[]>`
      SELECT price_paise::text, id FROM product_variants
      WHERE tenant_id = ${tenant} AND sku = 'ED-S'`;
    expect(Number(repriced!.price_paise)).toBe(65000);
  });

  it("keeps a variant the file does not mention rather than deleting it", async () => {
    sessionToken = token;

    const before = await admin<{ id: string; sku: string }[]>`
      SELECT id, sku FROM product_variants
      WHERE tenant_id = ${tenant} AND deleted_at IS NULL ORDER BY sku`;
    expect(before.map((v) => v.sku)).toEqual(["ED-M", "ED-S"]);

    // Only ED-S, priced differently so the product is a real change.
    const partial =
      "handle,title,sku,price,weight_grams\r\n" +
      "editable-shirt,Editable Shirt,ED-S,700,100\r\n";

    const dry = await importCsv(partial);
    expect(dry.report!.issues).toEqual([]);
    expect(dry.report!.results[0]!.variantsRetained).toBe(1);

    const { report } = await importCsv(partial, { commit: true });
    expect(report!.updated).toBe(1);

    const after = await admin<{ id: string; sku: string; deleted_at: Date | null }[]>`
      SELECT id, sku, deleted_at FROM product_variants
      WHERE tenant_id = ${tenant} ORDER BY sku`;

    // Destruction by omission is the hazard: a merchant correcting one
    // price in a spreadsheet has not asked for the other size to stop
    // being buyable.
    expect(after).toHaveLength(2);
    expect(after.every((v) => v.deleted_at === null)).toBe(true);
    // And the kept rows are the SAME rows — a Phase 2 order line will
    // point at these ids.
    expect(after.map((v) => v.id).sort()).toEqual(before.map((v) => v.id).sort());
  });

  it("leaves a column the file does not carry alone", async () => {
    sessionToken = token;

    const partial =
      "handle,title,sku,price,weight_grams\r\n" +
      "editable-shirt,Editable Shirt,ED-S,800,100\r\n";
    await importCsv(partial, { commit: true });

    const [variant] = await admin<{ barcode: string | null }[]>`
      SELECT barcode FROM product_variants WHERE tenant_id = ${tenant} AND sku = 'ED-S'`;
    const [product] = await admin<{ summary: string | null }[]>`
      SELECT summary FROM products WHERE tenant_id = ${tenant} AND title = 'Editable Shirt'`;

    // Absent is not empty. A five-column price update must not wipe
    // every barcode and summary in the catalog.
    expect(variant!.barcode).toBe("111222333");
    expect(product!.summary).toBe("Before");
  });

  it("ignores a blank cell on ONE row of a product, and clears on all of them", async () => {
    sessionToken = token;
    const original = (await exportCsv()).text;

    // Blank on the ED-S row only. The platforms merchants come from
    // write product columns on the first row of a group and leave them
    // blank after, so a blank cell states nothing — the other row's
    // value still stands.
    const partly = await importCsv(editCell(original, "summary", "", "ED-S"), { commit: true });
    expect(partly.report!.skipped).toBe(1);

    const [kept] = await admin<{ summary: string | null }[]>`
      SELECT summary FROM products WHERE tenant_id = ${tenant} AND title = 'Editable Shirt'`;
    expect(kept!.summary).toBe("Before");

    // Blank on every row of the handle is an instruction to clear it.
    const cleared = editCell(original, "summary", "", "editable-shirt");
    const all = await importCsv(cleared, { commit: true });
    expect(all.report!.updated).toBe(1);

    const [gone] = await admin<{ summary: string | null }[]>`
      SELECT summary FROM products WHERE tenant_id = ${tenant} AND title = 'Editable Shirt'`;
    expect(gone!.summary).toBeNull();
  });

  it("dry run names the fields an update changes, flagging clears", async () => {
    const tenant = await makeTenant();
    sessionToken = await makeSession(tenant, "owner");
    // Seed a product with a description via the normal import path.
    const seed =
      "handle,title,price,weight_grams,option1_name,option1_value,sku,description\r\n" +
      "diff-tee,Diff Tee,499.00,180,Size,M,DIFF-M,<p>Keep me.</p>\r\n";
    await importCsv(seed, { commit: true });

    // Same product, new title, description column present but blank.
    const update =
      "handle,title,price,weight_grams,option1_name,option1_value,sku,description\r\n" +
      "diff-tee,Diff Tee Renamed,499.00,180,Size,M,DIFF-M,\r\n";
    const { report } = await importCsv(update, { commit: false });

    expect(report!.updated).toBe(1);
    const result = report!.results.find((r) => r.handle === "diff-tee")!;
    expect(result.changes).toContain("title");
    expect(result.changes).toContain("description (cleared)");
    expect(result.changes).not.toContain("variants");
  });

  it("does not put a switched-off variant back on sale through a blank cell", async () => {
    const tenant = await makeTenant();
    sessionToken = await makeSession(tenant, "owner");

    await createProduct({
      title: "Off Switch",
      status: "active",
      axes: [{ name: "Size", values: ["S", "M"] }],
      variants: [
        { sku: "OS-S", options: { Size: "S" }, price: "500", weightGrams: 100 },
        // Deliberately withdrawn from sale in the console.
        { sku: "OS-M", options: { Size: "M" }, price: "500", weightGrams: 110, isActive: false },
      ],
    });

    // A hand-built file that CARRIES the column and leaves it empty —
    // which is what a merchant editing a subset of columns produces. The
    // price differs, so this is a real update rather than a skip.
    const csv =
      "handle,title,option1_name,option1_value,sku,price,weight_grams,variant_active\r\n" +
      "off-switch,Off Switch,Size,S,OS-S,600,100,\r\n" +
      "off-switch,Off Switch,Size,M,OS-M,600,110,\r\n";

    const { report } = await importCsv(csv, { commit: true });
    expect(report!.updated).toBe(1);

    const rows = await admin<{ sku: string; is_active: boolean }[]>`
      SELECT sku, is_active FROM product_variants
      WHERE tenant_id = ${tenant} AND deleted_at IS NULL ORDER BY sku`;

    // A blank cell states nothing. OS-M stays withdrawn — the merchant
    // did not ask for it to be buyable again, and the report carries
    // counts rather than a field-level diff, so nothing would have said
    // it had happened.
    expect(rows.map((r) => [r.sku, r.is_active])).toEqual([
      ["OS-M", false],
      ["OS-S", true],
    ]);
  });

  it("creates a product for a handle that matches nothing", async () => {
    sessionToken = token;

    const csv =
      "handle,title,status,sku,price,weight_grams,option1_name,option1_value\r\n" +
      "brand-new-tote,Brand New Tote,active,BNT-S,349.50,300,Size,Small\r\n" +
      "brand-new-tote,Brand New Tote,active,BNT-L,449.50,400,Size,Large\r\n";

    const dry = await importCsv(csv);
    expect(dry.report!.created).toBe(1);
    // The dry run inserted it and rolled back, so the id it saw is
    // already gone. Reporting it would give the console a dead link.
    expect(dry.report!.results[0]!.productId).toBeNull();

    const { report } = await importCsv(csv, { commit: true });
    expect(report!.created).toBe(1);
    expect(report!.results[0]!.slug).toBe("brand-new-tote");
    expect(report!.results[0]!.productId).not.toBeNull();

    const variants = await admin<{ sku: string; price_paise: string; weight_grams: number }[]>`
      SELECT v.sku, v.price_paise::text, v.weight_grams FROM product_variants v
      JOIN products p ON p.id = v.product_id
      WHERE p.tenant_id = ${tenant} AND p.title = 'Brand New Tote' ORDER BY v.position`;

    expect(variants.map((v) => v.sku)).toEqual(["BNT-S", "BNT-L"]);
    // 349.50 rupees is 34950 paise, exactly.
    expect(variants.map((v) => Number(v.price_paise))).toEqual([34950, 44950]);
    expect(variants.map((v) => v.weight_grams)).toEqual([300, 400]);
  });
});

describe("the whole file, or none of it", () => {
  it("writes nothing at all when one row of many is rejected", async () => {
    const tenant = await makeTenant();
    sessionToken = await makeSession(tenant, "owner");

    // An existing product owns TAKEN-1.
    await createProduct({
      title: "Existing",
      status: "draft",
      variants: [{ sku: "TAKEN-1", price: "10", weightGrams: 10 }],
    });

    const before = await snapshot(tenant);

    // Row 2 is perfectly fine. Row 3 claims a SKU another product
    // already holds, which only the write layer can know.
    const csv =
      "handle,title,sku,price,weight_grams\r\n" +
      "fine-one,Fine One,FINE-1,100,100\r\n" +
      "clashing,Clashing,TAKEN-1,100,100\r\n";

    const { status, report } = await importCsv(csv, { commit: true });

    expect(status).toBe(422);
    expect(report!.committed).toBe(false);
    expect(report!.issues).toHaveLength(1);
    // Row 3 of the spreadsheet — the header is row 1.
    expect(report!.issues[0]).toMatchObject({ row: 3, column: "sku" });
    expect(report!.issues[0]!.message).toContain("already belongs to another product");

    // "Fine One" is not in the catalog. Half a file committed is half a
    // catalog, and a merchant cannot tell which half.
    expect(await snapshot(tenant)).toEqual(before);
  });

  it("rejects a file with a bad cell before touching the database", async () => {
    const tenant = await makeTenant();
    sessionToken = await makeSession(tenant, "owner");

    const csv =
      "handle,title,sku,price,weight_grams\r\n" +
      "good-one,Good One,GOOD-1,100,100\r\n" +
      "bad-one,Bad One,BAD-1,free,100\r\n";

    const { status, report } = await importCsv(csv, { commit: true });

    expect(status).toBe(422);
    expect(report!.errored).toBe(1);
    expect(report!.issues[0]).toMatchObject({ row: 3, column: "price" });

    // Not listed at ₹0 — not listed at all.
    const [row] = await admin<{ count: string }[]>`
      SELECT count(*)::int AS count FROM products WHERE tenant_id = ${tenant}`;
    expect(Number(row!.count)).toBe(0);
  });
});

describe("caps that only bite once the file is merged over what is stored", () => {
  /**
   * `csv.ts` can only count what the file says. The product that reaches
   * the column is the file merged over the stored one — retained
   * variants appended, option values unioned — so a cap enforced on the
   * file alone is reachable in two imports that are each under it.
   *
   * What it costs: `productPayloadSchema` caps variants at 200 and an
   * axis's values at 50, and the console's edit form parses a product
   * back through it. Over either cap the merchant opens a product they
   * never touched, presses Save, and gets a 422 they cannot act on.
   */

  it("refuses a five-row file that would push an option past 50 values", async () => {
    const tenant = await makeTenant();
    sessionToken = await makeSession(tenant, "owner");

    const header = "handle,title,option1_name,option1_value,sku,price,weight_grams\r\n";
    const row = (i: number): string => `cap-opts,Cap Opts,Size,V${i},CO-${i},10,100\r\n`;

    // Fifty values exactly — at the cap, not over it.
    const first = await importCsv(
      header + Array.from({ length: 50 }, (_, i) => row(i)).join(""),
      { commit: true },
    );
    expect(first.status).toBe(200);
    expect(first.report!.created).toBe(1);

    // Five more. The file says 5; the product would say 55.
    const second = await importCsv(
      header + Array.from({ length: 5 }, (_, i) => row(50 + i)).join(""),
      { commit: true },
    );

    expect(second.status).toBe(422);
    expect(second.report!.committed).toBe(false);
    expect(second.report!.issues).toHaveLength(1);
    expect(second.report!.issues[0]).toMatchObject({ row: 2, column: "option1_value" });
    expect(second.report!.issues[0]!.message).toContain('"Size" would have 55 values');

    // Nothing was written: still 50 values and 50 variants.
    const values = await admin<{ count: string }[]>`
      SELECT count(*)::int AS count FROM product_option_values WHERE tenant_id = ${tenant}`;
    expect(Number(values[0]!.count)).toBe(50);
    const variants = await admin<{ count: string }[]>`
      SELECT count(*)::int AS count FROM product_variants
      WHERE tenant_id = ${tenant} AND deleted_at IS NULL`;
    expect(Number(variants[0]!.count)).toBe(50);
  });

  it("refuses a file that would push a product past 200 variants", async () => {
    const tenant = await makeTenant();
    sessionToken = await makeSession(tenant, "owner");

    const header =
      "handle,title,option1_name,option1_value,option2_name,option2_value,sku,price,weight_grams\r\n";
    const row = (size: number, colour: number): string =>
      `cap-vars,Cap Vars,Size,S${size},Colour,C${colour},CV-${size}-${colour},10,100\r\n`;

    // 50 sizes × 4 colours = 200 variants, and neither axis is over 50.
    const grid: string[] = [];
    for (let s = 0; s < 50; s++) for (let c = 0; c < 4; c++) grid.push(row(s, c));

    const first = await importCsv(header + grid.join(""), { commit: true });
    expect(first.status).toBe(200);
    expect(first.report!.created).toBe(1);

    // A fifth colour: 50 more rows, and 250 variants on the product.
    const more = Array.from({ length: 50 }, (_, s) => row(s, 4)).join("");
    const second = await importCsv(header + more, { commit: true });

    expect(second.status).toBe(422);
    expect(second.report!.committed).toBe(false);
    expect(second.report!.issues[0]).toMatchObject({ row: 2, column: "handle" });
    expect(second.report!.issues[0]!.message).toContain(
      '"cap-vars" would have 250 variants — 50 from this file and 200 already on the product',
    );
    expect(second.report!.issues[0]!.message).toContain(
      'To leave it untouched, remove its rows from the file; to shrink it, trim its variants in the console first.',
    );

    const variants = await admin<{ count: string }[]>`
      SELECT count(*)::int AS count FROM product_variants
      WHERE tenant_id = ${tenant} AND deleted_at IS NULL`;
    expect(Number(variants[0]!.count)).toBe(200);
  });
});

describe("tenancy", () => {
  /** SKUs are unique per tenant and the database survives between runs. */
  const run = randomUUID().slice(0, 6);

  it("takes the tenant from the session and ignores a tenant_id column", async () => {
    sessionToken = ownerToken;

    const csv =
      "handle,title,sku,price,weight_grams,tenant_id\r\n" +
      `session-tenant,Session Tenant,ST-${run},10,100,${tenantB}\r\n`;

    const { report } = await importCsv(csv, { commit: true });
    expect(report!.created).toBe(1);

    const [row] = await admin<{ tenant_id: string }[]>`
      SELECT p.tenant_id FROM products p
      JOIN product_variants v ON v.product_id = p.id
      WHERE v.sku = ${`ST-${run}`}`;
    expect(row!.tenant_id).toBe(tenantA);

    const [other] = await admin<{ count: string }[]>`
      SELECT count(*)::int AS count FROM products WHERE tenant_id = ${tenantB}`;
    expect(Number(other!.count)).toBe(0);
  });

  it("exports only the caller's own catalog", async () => {
    // Tenant B builds a product of its own…
    sessionToken = await makeSession(tenantB, "owner");
    await createProduct({
      title: "Tenant B Only",
      status: "active",
      variants: [{ sku: `TB-${run}`, price: "10", weightGrams: 10 }],
    });
    const theirs = await exportCsv();
    expect(theirs.text).toContain(`TB-${run}`);

    // …and it is nowhere in tenant A's export.
    sessionToken = ownerToken;
    const ours = await exportCsv();
    expect(ours.text).not.toContain(`TB-${run}`);
    expect(ours.text).toContain(`ST-${run}`);
  });

  it("creates a new product rather than editing another tenant's identical handle", async () => {
    // Both tenants can hold the same slug; `url_slugs` is keyed per
    // tenant. An importer matching handles globally would silently edit
    // someone else's product.
    const handle = `shared-${run}`;

    sessionToken = await makeSession(tenantB, "owner");
    await importCsv(
      `handle,title,sku,price,weight_grams\r\n${handle},Shared Handle,SH-B-${run},10,100\r\n`,
      { commit: true },
    );

    sessionToken = ownerToken;
    const mine = await importCsv(
      `handle,title,sku,price,weight_grams\r\n${handle},Shared Handle,SH-A-${run},20,100\r\n`,
      { commit: true },
    );
    expect(mine.report!.created).toBe(1);

    const rows = await admin<{ tenant_id: string; sku: string }[]>`
      SELECT p.tenant_id, v.sku FROM products p
      JOIN product_variants v ON v.product_id = p.id
      WHERE v.sku IN (${`SH-A-${run}`}, ${`SH-B-${run}`}) ORDER BY v.sku`;
    expect(rows.map((r) => r.sku)).toEqual([`SH-A-${run}`, `SH-B-${run}`]);
    expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([tenantA, tenantB]));

    // And each tenant's own handle still resolves to its own product.
    const slugs = await admin<{ tenant_id: string }[]>`
      SELECT tenant_id FROM url_slugs WHERE slug = ${handle} AND is_canonical`;
    expect(slugs).toHaveLength(2);
  });
});

describe("caps on the upload", () => {
  it("refuses more rows than one import may carry", async () => {
    sessionToken = ownerToken;

    const header = "handle,title,sku,price,weight_grams\r\n";
    const rows: string[] = [];
    for (let i = 0; i < MAX_IMPORT_ROWS + 2; i++) {
      rows.push(`p-${i},P ${i},SKU-${i},10,100\r\n`);
    }

    const response = await importRoute(
      new Request("http://console.test/api/products/import?commit=true", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: header + rows.join(""),
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "too_many_rows" } });

    const [row] = await admin<{ count: string }[]>`
      SELECT count(*)::int AS count FROM products
      WHERE tenant_id = ${tenantA} AND title LIKE 'P %'`;
    expect(Number(row!.count)).toBe(0);
  });

  it("refuses an empty upload rather than reporting a clean import of nothing", async () => {
    sessionToken = ownerToken;
    const { status, body } = await importCsv("");
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: "empty_file" } });
  });

  it("refuses a file that ends inside a quote", async () => {
    sessionToken = ownerToken;
    const { status, body } = await importCsv(
      'handle,title,sku,price,weight_grams\r\n"unterminated,X,X-1,10,100\r\n',
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: "invalid_csv" } });
  });
});
