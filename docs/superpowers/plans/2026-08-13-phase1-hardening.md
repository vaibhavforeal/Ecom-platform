# Phase 1 Hardening Fix Wave — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the triaged Phase 1 follow-ups: importer correctness, worker media resilience, storage config fail-closed hygiene, the client/server bundle boundary, PDP sanitise cost, the TLS-ask credential split, and integration-test leakage/lock contention.

**Architecture:** Eleven independent, individually-committable fixes on one branch (`phase1/hardening`). No schema migrations. The bundle-boundary fix works by moving `sanitize-html` behind the `catalog/server` barrel (whose client-import hard-failure Turbopack still enforces) rather than by adding the `server-only` package, which would crash the plain-Node worker and every vitest suite. The TLS-ask fix splits the credential because Caddy's `ask` directive cannot send headers — the secret rides the ask URL's query string.

**Tech Stack:** Next.js 16.3.0 (Turbopack), TypeScript, Drizzle + postgres.js, Vitest 2, BullMQ, sharp, pnpm + turbo monorepo.

## Global Constraints

- Work on branch `phase1/hardening`, cut from `master`. One commit minimum per task. End every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- `pnpm` is NOT on PATH. Run `export PATH="$HOME/.pnpm-shim:$PATH"` first in every shell. `corepack pnpm` alone breaks nested `pnpm --filter` calls.
- Ports are non-default on purpose: Postgres **5442**, PgBouncer 6442, Redis 6389, dev servers avoid 3000. Never "fix" these.
- Integration tests need Docker up: `pnpm infra:up`, and `DATABASE_URL_MIGRATOR` set in the repo-root `.env`.
- All relative imports are extensionless (`./sanitize-html`, never `./sanitize-html.ts` or `.js`).
- `NODE_ENV=development` is set in `.env`; build/start scripts override it with `dotenv -v NODE_ENV=production`. That override is load-bearing — never remove it.
- The CSV import's contracts are fixed: whole file in one transaction (all-or-nothing), an import never deletes variants absent from the file, a blank cell on one row states nothing, and a column present-but-blank-on-every-row of a handle is a deliberate clear (except `title`, `status`, `seo_noindex`, `variant_active`). Do not change these semantics; Task 2 makes the clear *visible*, not different.
- The cache purge is fail-soft by construction (`purge.ts` cannot throw or hang). Do not change that.
- Test fixtures writing jsonb through a bare `postgres()` client must bind `::text::jsonb` (see PROJECT_STATUS.md traps).
- Do not add stock/quantity columns — the inventory ledger is Phase 2.
- TDD: write the failing test, watch it fail, make it pass, run the file's suite. Where a task has no testable surface (comments, templates, client components with no DOM runner), the step says so explicitly.

---

### Task 1: `unescapeFormula` bijection — stop mutating foreign CSVs

The exporter's `escapeFormula` (`csv.ts:363-366`) prefixes `'` only when the first char is `'` or in `FORMULA_LEAD` (`= + - @ \t \r`, `csv.ts:351`). But `unescapeFormula` (`csv.ts:368-370`) strips a leading `'` from EVERY cell of every import — so a Shopify export with title `'90s Tee` or SKU `'0012` is silently mutated. The unescape must only strip what the escape could have produced.

**Files:**
- Modify: `packages/core/src/catalog/csv.ts:368-370`
- Test: `packages/core/tests/catalog-csv.test.ts`

**Interfaces:**
- Consumes: `FORMULA_LEAD` set at `csv.ts:351` (module-private, already in scope).
- Produces: no signature changes. `unescapeFormula` stays module-private.

- [ ] **Step 1: Write the failing tests** (next to the existing formula tests at `catalog-csv.test.ts:375-397`)

```ts
it("keeps a foreign file's legitimate leading apostrophe", () => {
  // A file this exporter never wrote (e.g. a Shopify export) may carry a
  // real leading apostrophe. Only strings escapeFormula could have
  // produced get unescaped: '=... '+... '-... '@... ''... '\t... '\r...
  const csv = [
    "handle,title,price,weight_grams,option1_name,option1_value,sku",
    `retro-tee,'90s Tee,499.00,180,Size,M,'0012`,
  ].join("\r\n");

  const parsed = parseCatalogCsv(csv);
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

  const parsed = parseCatalogCsv(csv);
  expect(parsed.products[0]!.title).toBe("=SUM(A1)");
  expect(parsed.products[0]!.variants[0]!.sku).toBe("'starts-with-quote");
});
```

- [ ] **Step 2: Run to verify both fail**

Run: `pnpm --filter @platform/core test catalog-csv`
Expected: FAIL — `'90s Tee` comes back as `90s Tee`, `'0012` as `0012` (first test); second test passes today — keep it anyway as the pin.

- [ ] **Step 3: Narrow the unescape**

Replace `csv.ts:368-370` with:

```ts
function unescapeFormula(value: string): string {
  if (value.charAt(0) !== "'") return value;
  const next = value.charAt(1);
  // Strip only what escapeFormula could have added: a guard in front of
  // a formula lead or in front of another apostrophe. A foreign file's
  // legitimate leading apostrophe ('90s Tee) passes through untouched.
  return next === "'" || FORMULA_LEAD.has(next) ? value.slice(1) : value;
}
```

Update `escapeFormula`'s docblock (`csv.ts:354-362`) — its bijection claim is now true for foreign files too; add one sentence: "The unescape strips only what this function could have produced, so a foreign file's legitimate leading apostrophe survives an import."

- [ ] **Step 4: Run the whole CSV unit suite**

Run: `pnpm --filter @platform/core test catalog-csv`
Expected: PASS, including the existing round-trip tests at lines 375-397 and 481-542.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/catalog/csv.ts packages/core/tests/catalog-csv.test.ts
git commit -m "fix(csv): only unescape apostrophes the exporter could have written"
```

---

### Task 2: Dry-run preview shows what an update changes

`isChanged` (`bulk.ts:584-626`) computes field-by-field differences and discards them into a boolean. `ImportReport` (`csv.ts:550-584`) carries counts and issues only, so a merchant whose file carries a blank `description` column sees "1 to update" and no hint that committing clears descriptions. Surface the field list, flagging clears.

**Files:**
- Modify: `packages/core/src/catalog/csv.ts:559-571` (`ImportProductResult`)
- Modify: `packages/core/src/catalog/bulk.ts` (`isChanged` → `changedFields`, result assembly)
- Modify: `apps/console/src/app/products/import/ImportPanel.tsx:178-244` (`Results`)
- Test: `packages/core/tests/catalog-csv.test.ts` (type only — no unit surface), `apps/console/tests/catalog-csv.integration.test.ts`

**Interfaces:**
- Produces: `ImportProductResult.changes: string[]` — human-readable field labels, `"<label> (cleared)"` when a non-empty stored value becomes empty/null, `"variants"` when any variant-level field differs. Empty array for `created`/`skipped` rows. `ImportReport` lives in `csv.ts` deliberately (client-bundle safety, `csv.ts:540-549`) — the new field stays there too.
- Consumes: the existing comparison logic in `isChanged` verbatim — this is a mechanical refactor of it; comparison semantics must not change.

- [ ] **Step 1: Write the failing integration test** (in `apps/console/tests/catalog-csv.integration.test.ts`, near the existing blank-column test at lines 490-513; reuse that test's fixture idioms)

```ts
it("dry run names the fields an update changes, flagging clears", async () => {
  const tenant = await makeTenant();
  const session = await makeSession(tenant);
  // Seed a product with a description via the normal import path.
  const seed = csvFile([
    "handle,title,price,weight_grams,option1_name,option1_value,sku,description",
    "diff-tee,Diff Tee,499.00,180,Size,M,DIFF-M,<p>Keep me.</p>",
  ]);
  await importCsv(seed, session, { commit: true });

  // Same product, new title, description column present but blank.
  const update = csvFile([
    "handle,title,price,weight_grams,option1_name,option1_value,sku,description",
    "diff-tee,Diff Tee Renamed,499.00,180,Size,M,DIFF-M,",
  ]);
  const { report } = await importCsv(update, session, { commit: false });

  expect(report.updated).toBe(1);
  const result = report.results.find((r) => r.handle === "diff-tee")!;
  expect(result.changes).toContain("title");
  expect(result.changes).toContain("description (cleared)");
  expect(result.changes).not.toContain("variants");
});
```

Adapt `csvFile`/`importCsv` to whatever helpers the suite actually uses (it constructs `Request` objects against the imported route handler — follow the file's existing tests exactly).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @platform/console test:integration catalog-csv`
Expected: FAIL — `changes` is `undefined`.

- [ ] **Step 3: Add the field to the type** (`csv.ts`, inside `ImportProductResult`)

```ts
export type ImportProductResult = {
  handle: string;
  row: number;
  outcome: ImportOutcome;
  productId: string | null;
  slug: string | null;
  variantsWritten: number;
  /** Live variants NOT named in the file. Kept, never deleted. */
  variantsRetained: number;
  /**
   * For an `updated` row: the fields this import changes, e.g.
   * `["title", "description (cleared)", "variants"]`. A "(cleared)"
   * suffix means a stored value becomes empty — the preview is the
   * merchant's only defence before committing a clear. Empty for
   * `created` and `skipped` rows.
   */
  changes: string[];
};
```

- [ ] **Step 4: Refactor `isChanged` into `changedFields`** (`bulk.ts:584-626`)

Mechanically transform: every comparison that today returns `true` instead pushes a label and continues. Keep every comparison expression byte-identical. Shape:

```ts
function changedFields(/* same params as isChanged */): string[] {
  const changes: string[] = [];
  const changed = (label: string, cleared = false) =>
    changes.push(cleared ? `${label} (cleared)` : label);

  // For each existing comparison, e.g. today's
  //   if (input.title !== existing.title) return true;
  // becomes
  //   if (input.title !== existing.title) changed("title");
  // For clearable text fields (summary, description, vendor, ...), pass
  //   cleared = <newValue is null/empty> && <stored value was not>
  // The description comparison stays EXACTLY
  //   cleanDescription(input.description) !== existing.description
  // (bulk.ts:588) with the cleared flag derived from its operands.

  // The per-variant index-for-index block (bulk.ts:602-621): on the
  // first differing variant field, changed("variants"); break out —
  // one label regardless of how many variants differ.

  return changes;
}
```

Replace `isChanged(...)` call sites with `changedFields(...)`, keeping a local `const changes = changedFields(...)` and testing `changes.length > 0` where the boolean was used. Thread `changes` into the `ImportProductResult` for `updated` outcomes; pass `[]` for `created` and `skipped`. Update `summarise` (`bulk.ts:201-221`) only if it constructs results directly.

- [ ] **Step 5: Run the failing test again, then the neighbouring suites**

Run: `pnpm --filter @platform/console test:integration catalog-csv`
Expected: PASS, including every pre-existing test — the skip/update outcomes must be unchanged (semantics preserved).
Run: `pnpm --filter @platform/core test` (typecheck of the shared type via tests) and `pnpm --filter @platform/core typecheck`.

- [ ] **Step 6: Render the changes in the preview** (`ImportPanel.tsx`, inside the `Results` row rendering, lines 178-244)

For rows with `outcome === "updated"` and `result.changes.length > 0`, render below the existing outcome badge:

```tsx
{result.outcome === "updated" && result.changes.length > 0 && (
  <span className="changes">{result.changes.join(", ")}</span>
)}
```

Match the component's existing class/markup conventions (read the file first). No DOM test runner exists for the console — this render is verified by reading; the data it renders is pinned by Step 1's test.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/catalog/csv.ts packages/core/src/catalog/bulk.ts apps/console/src/app/products/import/ImportPanel.tsx apps/console/tests/catalog-csv.integration.test.ts
git commit -m "feat(csv): dry-run preview names changed fields and flags clears"
```

---

### Task 3: ProductForm stops truncating fractional numbers client-side

`ProductForm.tsx:239-240` does `Number.parseInt(v.weightGrams, 10)` — so `"1.5"` becomes `1`, which then PASSES the server's `z.number().int()` (`catalog-input.ts:140`) and ships a silently wrong weight (the field every Phase 3 courier rate is computed from). `lowStockAt` has the same bug. Send the honest number and let the server's `.int()` refuse it.

**Files:**
- Modify: `apps/console/src/app/products/ProductForm.tsx:239-240`
- Test: `apps/console/tests/product-crud.integration.test.ts`

**Interfaces:**
- Consumes: `variantSchema` in `catalog-input.ts` — `weightGrams: z.number().int().min(0).max(500_000)` (line 140). No server change needed.
- Produces: no API change; the payload now carries `1.5` (rejected with a 422 field issue) instead of a silently truncated `1`.

- [ ] **Step 1: Write the failing server-side pin** (the client change itself has no test runner; pin the server behaviour the fix relies on, in `product-crud.integration.test.ts`, following its existing PUT tests)

```ts
it("refuses a fractional weight rather than truncating it", async () => {
  // Guards the ProductForm fix: the form now sends Number(input) verbatim,
  // so "1.5" must be refused here — not rounded, not truncated.
  const res = await putProduct(productId, {
    ...validPayload,
    variants: [{ ...validPayload.variants[0], weightGrams: 1.5 }],
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(JSON.stringify(body.error.details.issues)).toContain("weightGrams");
});
```

Adapt fixture/helper names to the suite's existing idioms.

- [ ] **Step 2: Run it**

Run: `pnpm --filter @platform/console test:integration product-crud`
Expected: PASS already (zod `.int()` refuses 1.5) — this is a characterisation pin so the client fix has a named guarantee to lean on. If it FAILS, stop: the plan's premise is wrong; investigate before touching the form.

- [ ] **Step 3: Fix the form's payload building** (`ProductForm.tsx:239-240`)

```ts
// Send what the merchant typed, as a number. The server's z.int() is
// the validator — parseInt here silently truncated "1.5" to 1, which
// the server then accepted. Blank stays null so it is refused loudly
// (a blank weight would otherwise quote shipping at zero).
weightGrams: v.weightGrams.trim() === "" ? null : Number(v.weightGrams),
lowStockAt: v.lowStockAt.trim() === "" ? null : Number(v.lowStockAt),
```

Then read `save()`'s error branch: if it already renders `details.issues` per field, done; if it only shows a generic banner, extend the banner to list `issues[].message` joined with `·` — smallest change that tells the merchant which field to fix. Match the file's existing error-rendering idiom.

- [ ] **Step 4: Verify by reading + typecheck + the suite**

Run: `pnpm --filter @platform/console typecheck && pnpm --filter @platform/console test:integration product-crud`
Expected: PASS. (No DOM runner: state in the commit message that the client half is verified by reading.)

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/app/products/ProductForm.tsx apps/console/tests/product-crud.integration.test.ts
git commit -m "fix(console): stop parseInt truncating fractional weight and low-stock input"
```

---

### Task 4: Over-cap product — prove the trim path, say the workaround

An over-cap legacy product (only reachable via SQL — no code path creates one) rejects any CSV file that touches it, and loading it in the console and saving unchanged 422s on the zod caps. Both refusals are correct per the rules; what's missing is an exit. Two cheap moves: prove the console trim path works (a payload trimmed to ≤ cap passes zod, and the write layer's soft-delete-then-revive replaces the whole variant set), and make the import rejection message state both workarounds. The all-or-nothing import transaction is a contract — do NOT redesign it.

**Files:**
- Modify: `packages/core/src/catalog/bulk.ts:311-355` (`overflowIssues` messages)
- Test: `apps/console/tests/product-crud.integration.test.ts`, `apps/console/tests/catalog-csv.integration.test.ts:643-726` (existing cap tests' message assertions)

**Interfaces:**
- Consumes: `MAX_VARIANTS_PER_PRODUCT = 200`, `MAX_OPTION_VALUES = 50` (`csv.ts:99-100`); the write layer's variant replacement semantics (`writes.ts` soft-deletes every live variant, revives the kept ones).
- Produces: no type changes; two message strings gain a trailing sentence.

- [ ] **Step 1: Write the failing trim-path test** (`product-crud.integration.test.ts`)

```ts
it("lets a merchant trim an over-cap product back under the cap", async () => {
  // No code path creates an over-cap product; simulate the legacy case
  // by inserting 201 variants directly (admin connection, like the
  // suite's other direct-SQL fixtures), then save a trimmed payload.
  const productId = await makeOverCapProduct(tenant, 201); // direct SQL, 201 variants, one option axis
  const trimmed = payloadWithVariants(200); // helper: valid payload, 200 variants
  const res = await putProduct(productId, trimmed);
  expect(res.status).toBe(200);

  const live = await admin`
    SELECT count(*)::int AS n FROM product_variants
    WHERE product_id = ${productId} AND deleted_at IS NULL`;
  expect(live[0]!.n).toBe(200);
});
```

Build `makeOverCapProduct` with the suite's admin client, writing rows the same way its other fixtures do (respect the two partial unique indexes: distinct SKUs, distinct option combinations).

- [ ] **Step 2: Run to verify it fails or passes**

Run: `pnpm --filter @platform/console test:integration product-crud`
Expected: PASS (zod validates the payload, not the stored state; the write layer replaces the set wholesale). If it fails, the escape hatch genuinely doesn't exist — stop and report; the fix is then real design work, not this task.

- [ ] **Step 3: Extend the two `overflowIssues` messages** (`bulk.ts:311-355`)

Append to the variants message: `" To leave it untouched, remove its rows from the file; to shrink it, trim its variants in the console first."` Append to the option-values message: `" To leave it untouched, remove its rows from the file; to shrink an axis, edit the product in the console first."`

- [ ] **Step 4: Update the existing message assertions and run both suites**

The cap tests at `catalog-csv.integration.test.ts:643-726` assert message fragments (`'"Size" would have 55 values'`) — those fragments still match; extend one assertion to pin the new workaround sentence.

Run: `pnpm --filter @platform/console test:integration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/catalog/bulk.ts apps/console/tests/product-crud.integration.test.ts apps/console/tests/catalog-csv.integration.test.ts
git commit -m "fix(csv): over-cap rejection names both escape hatches, trim path pinned by test"
```

---

### Task 5: Worker media hardening — checksum-collision adoption, curated failure reasons, honest docblock

Three defects in one subsystem. (1) The worker's checksum backfill (`process-media.ts:133-135`) can 23505 on `media_tenant_checksum_idx` at the final UPDATE (`:176-189`) when another row already owns the checksum — deterministically, on all 5 BullMQ retries, and the re-upload escape hatch dedupes onto the *other* row, so this row is stranded `failed` forever. (2) The catch writes raw `Error.message` into `processing_error` (`:208`), which `ProductForm.tsx:637` renders to the merchant — raw Postgres constraint text, storage-key-leaking messages (`:118`), S3 SDK errors. (3) `MAX_IMAGE_PIXELS`'s docblock (`validate.ts:34-42`) still claims to govern "every sharp() call" — false since the console got its own 30M `MAX_UPLOAD_PIXELS`.

**Files:**
- Modify: `apps/worker/src/jobs/process-media.ts`
- Modify: `packages/core/src/media/validate.ts:34-42` (docblock only)
- Test: `apps/worker/tests/process-media.integration.test.ts`

**Interfaces:**
- Consumes: `withTenant`, drizzle `media` schema, postgres.js error shape (`err.code === "23505"`, `err.constraint_name`) — verify the exact property on the caught error before relying on it (postgres.js may nest it; check `err.constraint_name ?? err.cause?.constraint_name`).
- Produces: `processing_error` now only ever holds merchant-readable strings; raw diagnostics go to the structured log. Existing invariants preserved: purge stays outside the try/catch (`:83-87`), mark-failed keeps its inner try/catch (`:195-224`), the job still rethrows on real failures.

- [ ] **Step 1: Write the failing collision test** (follow the suite's `givenPendingMedia` idiom, lines 62-81; fixtures via the BYPASSRLS `admin` client)

```ts
it("adopts a checksum collision instead of stranding the row as failed", async () => {
  // Row A: ready, owns checksum X (insert directly with the checksum of
  // the fixture bytes). Row B: pending, checksum NULL, same bytes — the
  // backfill computes X and would collide.
  const bytes = await fixtureImage(); // reuse the suite's smallest valid fixture
  const checksum = sha256hex(bytes);  // same hash the worker computes
  const rowA = await givenReadyMedia(tenantId, { checksum, bytes });
  const rowB = await givenPendingMedia(tenantId, { checksum: null, bytes });

  await processMedia(jobFor(rowB));

  const b = await adminRow(rowB);
  expect(b.status).toBe("ready");
  expect(b.checksum).toBeNull();          // NULLs are distinct under the unique index
  expect(b.derivatives.length).toBeGreaterThan(0);
  expect(b.processing_error).toBeNull();
});
```

Add `givenReadyMedia`/`adminRow` helpers only if the suite lacks equivalents.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @platform/worker test:integration`
Expected: FAIL — the job throws 23505, row B is `failed` with the raw constraint string.

- [ ] **Step 3: Implement collision adoption** (`process-media.ts`, around the final UPDATE at :176-189)

Extract the UPDATE into a local `markReady(checksumValue: string | null)`; then:

```ts
try {
  await markReady(checksum);
} catch (err) {
  if (!isChecksumCollision(err)) throw err;
  // Another row in this tenant already owns these bytes' checksum —
  // possible only on backfill (the upload route dedupes by checksum
  // before inserting). The derivatives are already built and stored;
  // completing the row with a NULL checksum keeps it working. NULLs
  // are distinct under media_tenant_checksum_idx, so this cannot
  // collide. The row simply never participates in dedupe.
  console.warn(JSON.stringify({
    level: "warn",
    event: "media.checksum_collision_adopted",
    mediaId, tenantId, checksum,
  }));
  await markReady(null);
}
```

`isChecksumCollision(err)`: walk `err` and `err.cause`, return true when `code === "23505"` and the constraint name is `media_tenant_checksum_idx`. Verify the real error shape in the failing test run's output before finalising.

- [ ] **Step 4: Run the collision test to verify it passes**

Run: `pnpm --filter @platform/worker test:integration`
Expected: PASS, all 9 pre-existing tests still green.

- [ ] **Step 5: Write the failing curated-message test**

```ts
it("writes a merchant-readable failure reason, and the raw error only to the log", async () => {
  const row = await givenPendingMedia(tenantId, { bytes: decompressionBomb() }); // suite builds one at lines 95-127
  await expect(processMedia(jobFor(row))).rejects.toThrow();
  const failed = await adminRow(row);
  expect(failed.status).toBe("failed");
  expect(failed.processing_error).toMatch(/pixel limit/i);       // still names the cause
  expect(failed.processing_error).not.toMatch(/VipsImage|sharp/); // no library internals
  expect(failed.processing_error).not.toContain(row.storage_key); // no internal keys
});
```

Check the existing bomb test's assertion (`:390`, `/pixel limit/i`) — keep both consistent.

- [ ] **Step 6: Implement the curated mapping** (in `process-media.ts`)

```ts
/**
 * processing_error feeds the merchant's screen verbatim (ProductForm
 * renders it), so it holds curated sentences only. The raw error goes
 * to the structured log where an operator can see it.
 */
function merchantFailureReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/pixel limit|exceeds.*pixel/i.test(raw))
    return "The image exceeds the pixel limit for processing.";
  if (/unsupported image format|source file|corrupt|premature end|invalid/i.test(raw))
    return "The file could not be decoded as an image.";
  if (/ENOENT|NoSuchKey|not found/i.test(raw))
    return "The original file could not be read from storage.";
  return "Processing failed inside the platform. Uploading the same file again retries it.";
}
```

In the catch (`:192-227`): log the raw message first (`event: "media.processing_failed"`, include `mediaId`, `tenantId`, raw `message`), then write `processingError: merchantFailureReason(err)` (keep the `MAX_ERROR_LENGTH` slice as a belt). Also change the dimension error at `:118` to throw `new Error("Could not read the image's dimensions.")` and log the `storageKey` separately at that site — the key must not reach the column.

- [ ] **Step 7: Run the suite; reconcile existing assertions**

Run: `pnpm --filter @platform/worker test:integration`
The pre-existing failure tests (`:225`, `:390`, `:414`, `:433`) assert on `processing_error` content — update any that pinned raw library text to pin the curated sentence instead. Expected: PASS.

- [ ] **Step 8: Correct the `MAX_IMAGE_PIXELS` docblock** (`validate.ts:34-42`, comment only)

```ts
/**
 * Pixel ceiling for the WORKER's sharp() calls (decode + derivative
 * encode). The console's request path deliberately enforces its own
 * lower ceiling — MAX_UPLOAD_PIXELS = 30M in apps/console/src/lib/
 * image.ts — so an image between the two limits is refused at upload
 * rather than tying up a request worker. If you change either value,
 * keep MAX_UPLOAD_PIXELS < MAX_IMAGE_PIXELS: the console integration
 * suite pins both values and their ordering.
 */
```

- [ ] **Step 9: Commit**

```bash
git add apps/worker/src/jobs/process-media.ts packages/core/src/media/validate.ts apps/worker/tests/process-media.integration.test.ts
git commit -m "fix(worker): adopt checksum collisions, curate processing_error, honest pixel-limit docblock"
```

---

### Task 6: Storage driver — blank means unset, template stops pre-deciding

`.env.example:105` pre-fills `STORAGE_DRIVER=local`, so copying the template into production satisfies the fail-closed gate without a decision. But shipping the template blank breaks dev today: `getStorage()` (`storage/index.ts:27`) uses `process.env.STORAGE_DRIVER ?? "local"`, and `"" ?? "local"` keeps `""` → the "Unknown STORAGE_DRIVER" throw. Make blank behave as unset everywhere, then blank the template. Also: `packages/integrations` has no vitest config, so `vi.stubEnv` leaks across `storage/index.test.ts` (one test at lines 53-64 already re-stubs four vars to undo an earlier leak).

**Files:**
- Create: `packages/integrations/vitest.config.ts`
- Modify: `packages/integrations/src/storage/index.ts:27-29`
- Modify: `.env.example:100-105`
- Test: `packages/integrations/src/storage/index.test.ts`

**Interfaces:**
- Produces: `getStorage()` treats `STORAGE_DRIVER=""` exactly like unset — defaults to `local` in development, throws in production.
- Consumes: nothing new.

- [ ] **Step 1: Create the vitest config** (`packages/integrations/vitest.config.ts`)

```ts
import { defineConfig } from "vitest/config";

/**
 * unstubEnvs matters here: storage/index.test.ts drives getStorage()
 * entirely through vi.stubEnv, and without automatic unstubbing each
 * test inherits the previous test's environment — one test already
 * re-stubbed four vars to undo a leak before this config existed.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    unstubEnvs: true,
  },
});
```

- [ ] **Step 2: Run the existing suite to confirm the config holds**

Run: `pnpm --filter @platform/integrations test`
Expected: PASS (both `storage/index.test.ts` and `tests/carriers.test.ts` are matched by the include globs — verify the reported file count is 2). The four re-stubs to `undefined` at `index.test.ts:56-59` are now redundant but harmless; leave them — they make the test's own preconditions explicit.

- [ ] **Step 3: Write the failing blank-driver tests** (in `storage/index.test.ts`)

```ts
it("treats a blank STORAGE_DRIVER as unset in development", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("STORAGE_DRIVER", "");
  const { getStorage } = await import("./index");
  expect(() => getStorage()).not.toThrow(); // falls back to the local driver
});

it("treats a blank STORAGE_DRIVER as unset in production — refuses to default", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("STORAGE_DRIVER", "");
  const { getStorage } = await import("./index");
  expect(() => getStorage()).toThrow("STORAGE_DRIVER is required in production");
});
```

- [ ] **Step 4: Run to verify the first fails**

Run: `pnpm --filter @platform/integrations test`
Expected: first test FAILS (`Unknown STORAGE_DRIVER: ""`), second already passes (`!""` is truthy).

- [ ] **Step 5: Make blank mean unset** (`storage/index.ts:27`)

```ts
// || not ??: a blank value in .env means "no decision", same as unset.
const driver = process.env.STORAGE_DRIVER || "local";
```

(The production gate at `:29` already treats `""` as unset — `!process.env.STORAGE_DRIVER`.)

- [ ] **Step 6: Blank the template** (`.env.example:100-105`)

```
# ── Storage ─────────────────────────────────────────────────
# Storage driver selection: "local" or "s3".
# Blank or unset = "local" in development. In production the platform
# REFUSES TO START without an explicit value — pre-filling one here
# would let a copied template silently write uploads to ephemeral
# container disk. Decide, then set it.
STORAGE_DRIVER=
```

- [ ] **Step 7: Run the whole package + a smoke of dev startup assumptions**

Run: `pnpm --filter @platform/integrations test && pnpm --filter @platform/integrations typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/integrations/vitest.config.ts packages/integrations/src/storage/index.ts packages/integrations/src/storage/index.test.ts .env.example
git commit -m "fix(storage): blank STORAGE_DRIVER means unset; template stops pre-deciding; stubEnv hygiene"
```

---

### Task 7: PDP sanitise moves inside the cache boundary

The PDP re-sanitises up to 60 kB of description HTML on every request (`[slug]/page.tsx:361-383`), under `force-dynamic`, against a 2.5 s LCP budget — while the value it sanitises came from `unstable_cache` (`lib/catalog.ts:62-71`) and is identical for the cache entry's whole 300 s life. Move the defence-in-depth pass to the cache fill: same protection (every render path goes through the cache), amortised cost. No test pins the current pass — add the one that should have existed.

**Files:**
- Modify: `apps/storefront/src/lib/catalog.ts:62-71` (`getCachedProduct`)
- Modify: `apps/storefront/src/app/[slug]/page.tsx:5-10` (imports), `:361-383` (render + comment)
- Test: create `apps/storefront/tests/description-sanitise.integration.test.ts`

**Interfaces:**
- Consumes: `sanitizeDescriptionHtml` (import from `@platform/core/catalog` for now — Task 8 moves it to `@platform/core/catalog/server`, which `lib/catalog.ts` already imports from; Task 8 owns that import flip). `runDynamicRender` from `apps/storefront/tests/next-cache-harness.ts` — any "visitor sees X" assertion MUST go through it (bare `unstable_cache` reads diverge from production; see PROJECT_STATUS traps).
- Produces: `getCachedProduct` returns `ProductDetail` whose `description` is already sanitised. The PDP renders it directly.

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
// Follow product-images.integration.test.ts for the admin/fixture setup
// and cache-purge.integration.test.ts for the harness usage.

describe("description defence-in-depth at the cache boundary", () => {
  // Fixture: tenant + product inserted via the admin client with a
  // HOSTILE description written straight to the column — simulating the
  // write-layer bypass (psql, restored dump, seed) the pass exists for.
  // description: '<p>ok</p><script>alert(1)</script>'

  it("a visitor never receives markup the sanitiser would strip", async () => {
    const detail = await runDynamicRender(() => getCachedProduct(tenantId, productId));
    expect(detail!.description).toContain("<p>ok</p>");
    expect(detail!.description).not.toContain("<script>");
  });
});
```

Copy the suite scaffolding (env, admin client, plan/tenant fixture with cleanup in `afterAll` — use the model teardown: `DELETE FROM tenants WHERE id = ...`, then the plan row) from `product-images.integration.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @platform/storefront test:integration description-sanitise`
Expected: FAIL — the cached detail still carries `<script>` (today's sanitise happens later, in the component).

- [ ] **Step 3: Sanitise at the cache fill** (`lib/catalog.ts`)

```ts
export function getCachedProduct(tenantId: string, productId: string) {
  return unstable_cache(
    async () => {
      const product = await getProductById(tenantId, productId);
      // Defence in depth, amortised: descriptions are sanitised on
      // write, but a row written past the write layer (psql, a restored
      // dump, a backfill) must still never reach
      // dangerouslySetInnerHTML. Sanitising here covers every render of
      // this cache entry for the price of one pass per fill. The
      // sanitiser is idempotent, so a correctly written row is
      // unchanged.
      if (product?.description) {
        return { ...product, description: sanitizeDescriptionHtml(product.description) || null };
      }
      return product;
    },
    ["product", tenantId, productId],
    {
      tags: [catalogTags.all(tenantId), catalogTags.product(tenantId, productId)],
      revalidate: TTL_SECONDS,
    },
  )();
}
```

- [ ] **Step 4: Simplify the PDP render** (`[slug]/page.tsx:361-383`)

Replace the comment block and the call: the long comment moves conceptually to `lib/catalog.ts` (Step 3 carries its content); at the render site leave two lines:

```tsx
{/* Sanitised at the cache fill in lib/catalog.ts — never render a
    description that has not passed through getCachedProduct. */}
{product.description && (
  <div className="prose" dangerouslySetInnerHTML={{ __html: product.description }} />
)}
```

Remove `sanitizeDescriptionHtml` from the page's import list (`page.tsx:5-10`).

- [ ] **Step 5: Run the new test and the full storefront suite**

Run: `pnpm --filter @platform/storefront test:integration`
Expected: PASS (new test + the 15 existing).

- [ ] **Step 6: Commit**

```bash
git add apps/storefront/src/lib/catalog.ts "apps/storefront/src/app/[slug]/page.tsx" apps/storefront/tests/description-sanitise.integration.test.ts
git commit -m "perf(storefront): sanitise descriptions at cache fill, not per request — now pinned by test"
```

---

### Task 8: Move `sanitize-html` behind the server barrel — the boundary guard, restored by construction

Under Next 15 + webpack, a client component importing `@platform/core/catalog` (which `export *`s `sanitize-html.ts`, → `postcss` → `fs`) was a build error. Turbopack builds it and ships ~190 kB instead. The follow-ups doc proposed `import "server-only"` — **that approach is dead**: the worker imports both files through four plain-Node chains (crashes at startup: `server-only`'s default condition throws), every vitest suite runs under default Node conditions, and `ProductForm.tsx:6` (a client component) legitimately imports `ALLOWED_DESCRIPTION_TAGS`, defined inside `sanitize-html.ts`. Instead: extract the client-safe constants to a pure module, and move `sanitize-html` out of the pure barrel into `catalog/server` — whose client-import hard-failure (postgres driver → `fs`/`net`) Turbopack still enforces (probed both directions, PROJECT_STATUS.md:450-452).

**Files:**
- Create: `packages/core/src/catalog/description-policy.ts`
- Modify: `packages/core/src/catalog/sanitize-html.ts` (constants out, docblock fixed)
- Modify: `packages/core/src/catalog/index.ts:18` (pure barrel: swap the export)
- Modify: `packages/core/src/catalog/server.ts` (add the export)
- Modify: `apps/storefront/src/lib/catalog.ts` (import flip from Task 7)
- Modify: `PROJECT_STATUS.md:319-324` (stale webpack-era trap entry)
- Test: `packages/core/tests/sanitize-html.test.ts` (imports unchanged — direct file imports keep working), `packages/core/tests/catalog.test.ts`

**Interfaces:**
- Produces: `@platform/core/catalog` no longer evaluates `sanitize-html` (or `postcss`) at all. `ALLOWED_DESCRIPTION_TAGS` and `ALLOWED_LINK_SCHEMES` remain importable from `@platform/core/catalog` (now via `description-policy.ts`). `sanitizeDescriptionHtml` is importable from `@platform/core/catalog/server` (and from `@platform/core` root barrel, which was already server-grade — it re-exports `catalog/server`).
- Consumes: Task 7 must land first (the PDP no longer imports `sanitizeDescriptionHtml`; only `lib/catalog.ts` and `writes.ts` do).

- [ ] **Step 1: Extract the constants**

`description-policy.ts` — move `ALLOWED_DESCRIPTION_TAGS` (sanitize-html.ts:53-67) and `ALLOWED_LINK_SCHEMES` (:77) verbatim, with their docblocks. Header comment:

```ts
/**
 * The description-markup policy, as pure data. Lives apart from the
 * sanitiser so client components (the console's editor toolbar) can
 * import the ALLOWED lists without dragging sanitize-html — and its
 * fs-reading postcss dependency — into a client bundle.
 */
```

In `sanitize-html.ts`: delete the moved declarations, add `import { ALLOWED_DESCRIPTION_TAGS, ALLOWED_LINK_SCHEMES } from "./description-policy";` and `export * from "./description-policy";` (direct-file importers — the unit tests — keep working unchanged).

- [ ] **Step 2: Swap the barrels**

`catalog/index.ts:18`: replace `export * from "./sanitize-html";` with `export * from "./description-policy";`
`catalog/server.ts`: append `export * from "./sanitize-html";`

- [ ] **Step 3: Flip the two value-importers of the moved function**

- `apps/storefront/src/lib/catalog.ts`: import `sanitizeDescriptionHtml` from `@platform/core/catalog/server` (it already imports six query functions from there — merge into that import).
- `packages/core/src/catalog/writes.ts:29` already imports from `./sanitize-html` directly — unchanged.
- Confirm nothing else imports the function from the pure barrel: `grep -rn "sanitizeDescriptionHtml" apps packages --include=*.ts --include=*.tsx` must show only: `sanitize-html.ts`, `writes.ts`, `lib/catalog.ts`, `packages/core/tests/sanitize-html.test.ts`, and Task 7's new storefront test.

- [ ] **Step 4: Fix the two stale docblocks**

- `sanitize-html.ts:33-40` still claims webpack tree-shaking + client-import build failure. Rewrite: "This module lives behind `@platform/core/catalog/server`. The pure `@platform/core/catalog` barrel must never re-export it: under Turbopack a client import would not fail the build — it would silently ship sanitize-html (~190 kB with postcss) to browsers. The `catalog/server` barrel also pulls the postgres driver, whose `fs`/`net` imports DO still hard-fail a client build, which is the guard."
- `PROJECT_STATUS.md:319-324` (the `sanitize-html pulls in postcss` trap entry): rewrite to match — the entry currently contradicts the Turbopack note at :443-452.

- [ ] **Step 5: Reconcile the unit tests and run everything**

`catalog.test.ts:25` imports 22 symbols from `../src/catalog/index` — if any come from `sanitize-html.ts` beyond the two constants (now re-exported via description-policy), import those from `../src/catalog/sanitize-html` directly instead, mirroring the file's own comment about keeping the postgres driver out of the unit suite.

Run: `pnpm --filter @platform/core test && pnpm --filter @platform/core typecheck && pnpm typecheck`
Expected: PASS across the workspace (console `ProductForm`/`ImportPanel`/`VariantPicker` imports resolve unchanged through the pure barrel).

- [ ] **Step 6: Build both apps and verify the chunks**

Run: `pnpm build`
Expected: 2/2 apps build.
Then grep the shipped client chunks:

```bash
grep -rl "sanitize-html\|ALLOWED_LINK_SCHEMES" apps/console/.next/static/chunks apps/storefront/.next/static/chunks || echo CLEAN
```

Expected: `CLEAN` for sanitize-html (the constants themselves may legitimately appear — ProductForm uses them; refine the grep to the package name `sanitize-html` if the constant names hit). Record the result in the commit message.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/catalog/description-policy.ts packages/core/src/catalog/sanitize-html.ts packages/core/src/catalog/index.ts packages/core/src/catalog/server.ts apps/storefront/src/lib/catalog.ts PROJECT_STATUS.md packages/core/tests/catalog.test.ts
git commit -m "fix(core): move sanitize-html behind the server barrel — client bundles cannot ship it"
```

---

### Task 9: Split the TLS-ask credential and close verify-domain

`INTERNAL_API_SECRET` guards two capabilities: the storefront purge endpoint (fails closed, tested) and the console's `verify-domain` (`apps/console/src/app/api/internal/verify-domain/route.ts:20-48`), which SKIPS its check when the secret is unset — fail open, zero tests. The investigation found the deeper problem: **the Caddyfile's `on_demand_tls { ask ... }` stanza sends no header and cannot** — so if the shared secret is set in the console's environment, verify-domain 403s every ask and certificate issuance dies. `.env.example:52-53`'s claim that "Caddy presents it" is false. Fix: a dedicated `TLS_ASK_SECRET` carried in the ask URL's query string (Caddy substitutes `{$TLS_ASK_SECRET}` at Caddyfile parse), fail closed in production, relaxed in development/test like the storefront's `internal-auth.ts`.

**Files:**
- Modify: `apps/console/src/app/api/internal/verify-domain/route.ts`
- Modify: `infra/caddy/Caddyfile:13-31` (the `ask` URL)
- Modify: `.env.example:50-62` (+ new entry)
- Modify: `turbo.json` `globalEnv` (add `TLS_ASK_SECRET`)
- Modify: `docs/PHASE1_FOLLOWUPS.md:42-45`, `PLATFORM_BLUEPRINT.md:200` (mentions)
- Test: create `apps/console/tests/verify-domain.integration.test.ts`

**Interfaces:**
- Produces: verify-domain auth = `?secret=<TLS_ASK_SECRET>` query param, constant-time compared. Unset secret: allowed in `development`/`test` NODE_ENV, 403 otherwise. `INTERNAL_API_SECRET` shrinks to one capability (the purge) — its purge-side code is untouched.
- Consumes: `isDomainVerifiedForTls` (unchanged); the storefront's `RELAXED_ENVIRONMENTS` pattern (`internal-auth.ts:24`) as the model.

- [ ] **Step 1: Write the failing tests** (new suite; copy scaffolding — admin client, env loading, cleanup — from `media-upload.integration.test.ts`; include the Task 10 model teardown from the start: delete created tenants, then plans)

```ts
describe("GET /api/internal/verify-domain", () => {
  // Fixture: a tenant with a TLS-verified domain (insert whatever rows
  // isDomainVerifiedForTls reads — follow the function's source) and a
  // known-unverified domain string.

  it("200s a verified domain when the ask secret matches", async () => {
    vi.stubEnv("TLS_ASK_SECRET", "ask_secret_under_test");
    const res = await GET(new Request(
      `http://console/api/internal/verify-domain?domain=${verifiedDomain}&secret=ask_secret_under_test`,
    ));
    expect(res.status).toBe(200);
  });

  it("403s a wrong secret without consulting domain state", async () => {
    vi.stubEnv("TLS_ASK_SECRET", "ask_secret_under_test");
    const res = await GET(new Request(
      `http://console/api/internal/verify-domain?domain=${verifiedDomain}&secret=wrong`,
    ));
    expect(res.status).toBe(403);
  });

  it("fails CLOSED outside development and test when no secret is configured", async () => {
    vi.stubEnv("TLS_ASK_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(new Request(
      `http://console/api/internal/verify-domain?domain=${verifiedDomain}`,
    ));
    expect(res.status).toBe(403);
  });

  it("stays usable in development with no secret configured", async () => {
    vi.stubEnv("TLS_ASK_SECRET", "");
    vi.stubEnv("NODE_ENV", "development");
    const res = await GET(new Request(
      `http://console/api/internal/verify-domain?domain=${verifiedDomain}`,
    ));
    expect(res.status).toBe(200);
  });

  it("still 403s an unverified domain even with a valid secret", async () => {
    vi.stubEnv("TLS_ASK_SECRET", "ask_secret_under_test");
    const res = await GET(new Request(
      `http://console/api/internal/verify-domain?domain=attacker.example&secret=ask_secret_under_test`,
    ));
    expect(res.status).toBe(403);
  });
});
```

Note: the console integration configs don't set `unstubEnvs` — save/restore env explicitly in `beforeEach`/`afterEach` if `vi.stubEnv` leaks between tests here (or set `vi.unstubAllEnvs()` in `afterEach`).

- [ ] **Step 2: Run to verify the fail-closed test fails**

Run: `pnpm --filter @platform/console test:integration verify-domain`
Expected: the fail-closed-in-production test FAILS today (route skips the check); the matching-secret tests also fail (secret currently read from header, not query).

- [ ] **Step 3: Rewrite the route's auth** (`verify-domain/route.ts`)

```ts
const RELAXED_ENVIRONMENTS = new Set(["development", "test"]);

/**
 * Caddy's on_demand_tls `ask` cannot attach headers, so the secret
 * rides the ask URL's query string — set once in the Caddyfile via
 * {$TLS_ASK_SECRET}. This is a DEDICATED credential: it must never be
 * INTERNAL_API_SECRET, which authorises cache purges on the storefront.
 * A leaked ask URL should decide nothing but TLS issuance.
 */
function askSecretOk(url: URL): boolean {
  const expected = process.env.TLS_ASK_SECRET;
  if (!expected) return RELAXED_ENVIRONMENTS.has(process.env.NODE_ENV ?? "");
  const provided = Buffer.from(url.searchParams.get("secret") ?? "");
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}
```

In `GET`: replace the `INTERNAL_API_SECRET` header block (lines 24-34) with `if (!askSecretOk(url)) return new NextResponse(null, { status: 403 });` before the domain check. Everything from the `domain` null-check down is unchanged.

- [ ] **Step 4: Run the suite**

Run: `pnpm --filter @platform/console test:integration verify-domain`
Expected: PASS ×5.

- [ ] **Step 5: Update Caddyfile, env template, turbo, docs**

- Caddyfile: `ask http://console:3001/api/internal/verify-domain?secret={$TLS_ASK_SECRET}` (Caddy appends `&domain=...` correctly to a URL that already has a query). Extend the "THE SECURITY GATE" comment: the secret is dedicated; rotating the purge secret must not touch TLS issuance and vice versa.
- `.env.example`: correct the `INTERNAL_API_SECRET` comment block (purge only; remove the false "Caddy presents it" claim) and add:

```
# Dedicated secret for Caddy's on-demand-TLS ask endpoint. Caddy embeds
# it in the ask URL ({$TLS_ASK_SECRET} in the Caddyfile), because the
# ask directive cannot send headers. Deliberately NOT the same value as
# INTERNAL_API_SECRET — a leaked ask URL should decide nothing but TLS
# issuance. Unset: allowed in development, refused in production.
TLS_ASK_SECRET=dev_only_change_me_1111111111111111111111111111111111111111111111111111
```

- `turbo.json` `globalEnv`: add `"TLS_ASK_SECRET"`.
- `docs/PHASE1_FOLLOWUPS.md:42-45`: rewrite the known-limitation entry as resolved (this task's design in two lines). `PLATFORM_BLUEPRINT.md:200`: append `?secret={$TLS_ASK_SECRET}` to the quoted ask URL.

- [ ] **Step 6: Full console suite + typecheck**

Run: `pnpm --filter @platform/console test:integration && pnpm --filter @platform/console typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/console/src/app/api/internal/verify-domain/route.ts apps/console/tests/verify-domain.integration.test.ts infra/caddy/Caddyfile .env.example turbo.json docs/PHASE1_FOLLOWUPS.md PLATFORM_BLUEPRINT.md
git commit -m "fix(security): dedicated TLS_ASK_SECRET in the ask URL; verify-domain fails closed in production"
```

---

### Task 10: Integration suites clean up after themselves; the lock holder runs alone

Six suites leak (~35 tenants/run); four are clean via one idiom: `DELETE FROM tenants WHERE id IN (...)` on the migrator connection, cascade does the rest (`isolation.test.ts:131-135` is the model). Even the clean four leak their `plans` row, and the console suites leak `users` rows (no tenant cascade covers users). Separately, `media-dedupe-migration.test.ts` holds `ACCESS EXCLUSIVE` on `media` across its whole rewind-seed-replay transaction while turbo runs five packages' suites concurrently against one Postgres. Fix the leaks suite-by-suite, and serialise via turbo's dependency graph so the lock holder (packages/db) runs before everything that would block on it.

**Files:**
- Modify (leaking suites): `apps/console/tests/cache-purge.integration.test.ts:222-228`, `apps/console/tests/catalog-csv.integration.test.ts:197-201`, `apps/console/tests/media-upload.integration.test.ts:162-167`, `apps/console/tests/product-crud.integration.test.ts:198-202`, `apps/storefront/tests/cache-purge.integration.test.ts:207-210`, `apps/worker/tests/process-media.integration.test.ts:200-205` (also its `beforeAll` env mutation at :175-176)
- Modify (plan/user leaks in clean suites): `packages/db/tests/isolation.test.ts`, `packages/db/tests/media-checksum.test.ts`, `packages/core/tests/catalog-queries.integration.test.ts`, `apps/storefront/tests/product-images.integration.test.ts`
- Modify: `turbo.json` (`test:integration` gains `dependsOn`)

**Interfaces:**
- Consumes: every suite already tracks (or can trivially track) what it creates; tenant FKs cascade from `tenants.id`; `users` and `plans` need their own deletes.
- Produces: a full `pnpm test:integration` run leaves the tenant/plan/user counts where it found them.

- [ ] **Step 1: Instrument each leaking suite to track its rows**

In each of the six, the local `makeTenant`/`mkTenant` pushes into module-level arrays; `makeSession`/user-creating helpers push user ids; the plan id is already a known const. Where a suite creates tenants inline in tests (`catalog-csv` ×9, storefront `cache-purge` per-fixture), the push lives inside the helper so no call site changes. **Do not restructure the storefront cache-purge suite's fresh-tenant-per-test design — it is load-bearing** (Next's tag manifest is process-global; header comment :43-48). Cleanup is additive, in `afterAll` only.

- [ ] **Step 2: Add the teardown to all six, before the pool closes**

```ts
afterAll(async () => {
  // ... existing server/redis closes first, unchanged ...
  if (createdTenants.length > 0) {
    await admin`DELETE FROM tenants WHERE id IN ${admin(createdTenants)}`;
  }
  if (createdUsers.length > 0) {
    await admin`DELETE FROM users WHERE id IN ${admin(createdUsers)}`;
  }
  await admin`DELETE FROM plans WHERE id = ${planId}`;
  // ... existing admin.end()/closeConnections(), unchanged ...
});
```

Order matters: tenants first (cascades `tenant_members`/`sessions`), then users, then the plan. Check each suite's actual variable names for the admin client and plan id; some create the plan inside `makeTenant` — dedupe with a `Set` if so.

- [ ] **Step 3: Close the plan-row leak in the four clean suites**

Add the `DELETE FROM plans` line to their existing `afterAll`s (they already delete tenants). `product-images` and `catalog-queries` create one plan each; the db suites likewise. The storefront `cache-purge` suite also creates one `users` row (:201-204) — include it in Step 2's user cleanup.

- [ ] **Step 4: Fix the worker suite's env mutation**

`process-media.integration.test.ts:175-176` sets `INTERNAL_API_SECRET`/`STOREFRONT_INTERNAL_ORIGIN` in `beforeAll` with no restore. Capture the prior values and restore them in `afterAll`. (Vitest workers are per-file processes, so today it leaks nowhere — this is hygiene so a future shared-process runner doesn't inherit it silently.)

- [ ] **Step 5: Serialise the lock holder via the task graph** (`turbo.json`)

```json
"test:integration": {
  "cache": false,
  "outputs": [],
  "dependsOn": ["^test:integration"]
}
```

Topology: `packages/db` (the `ACCESS EXCLUSIVE` holder) runs first and alone; `packages/core` next; the three apps still run concurrently with each other — none of them takes table locks. Document why in a one-line comment if turbo.json permits none, put it in the commit message instead (turbo.json does not support comments).

- [ ] **Step 6: Verify — two consecutive full runs, stable counts**

```bash
psql "$DATABASE_URL_MIGRATOR" -c "SELECT count(*) FROM tenants" # note N before
pnpm test:integration
psql "$DATABASE_URL_MIGRATOR" -c "SELECT count(*) FROM tenants" # must still be N
pnpm test:integration                                            # and green twice in a row
```

(Adjust to the Windows shell reality: `docker exec` into the Postgres container for psql if none is installed locally — check `infra/docker/docker-compose.dev.yml` for the container name.) Expected: identical tenant counts before/after, both runs green, and the run's wall-clock not degraded beyond the serialisation cost.

- [ ] **Step 7: One-off sweep of the historically leaked rows** (manual, not committed code)

The dev volume holds ~35 leaked tenants from past runs with prefixes `iso-a- iso-b- chk- cp- csv- u- c- s- m- sf- q-a- q-b- q-c-` and random-suffix plan codes/users (`+9199…` phone prefixes). Delete by prefix with a `SELECT` first to eyeball the list — `acme` and `globex` must survive. Record the counts deleted in the task report; do not script this into the repo.

- [ ] **Step 8: Commit**

```bash
git add apps/console/tests apps/storefront/tests apps/worker/tests packages/db/tests packages/core/tests/catalog-queries.integration.test.ts turbo.json
git commit -m "fix(tests): integration suites delete what they create; db's lock-holding suite runs alone"
```

---

### Task 11: Full gate + status reconciliation

- [ ] **Step 1: Run the complete gate on the branch**

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:integration
```

Expected: lint clean, 6/6 typecheck, 2/2 builds, all unit + integration suites green. Record exact counts.

- [ ] **Step 2: Update `PROJECT_STATUS.md`**

Add a "Re-verified 2026-08-13 (hardening wave)" block with the counts and their delta from 321/174, attributing every count change to its task. Update the trap list only where this wave changed a documented mechanism (Task 8 already rewrote the sanitize-html entry). Do NOT record any mechanism that was not probed — three wrong mechanisms went into this file last branch; the rule is probe first, write second.

- [ ] **Step 3: Update `docs/PHASE1_FOLLOWUPS.md`**

Move every item this wave fixed out of "Fix soon" into a short "Fixed in the hardening wave (2026-08-13)" section, one line each naming the commit. Items NOT fixed by this plan stay: the PDP `generateMetadata` raw-description pass (observed, deliberate), CSP/CSRF/rate-limits (deferred by design), `search_indexing` writer (separate feature), multi-replica purge fan-out (deployment fact).

- [ ] **Step 4: Commit**

```bash
git add PROJECT_STATUS.md docs/PHASE1_FOLLOWUPS.md
git commit -m "docs: record the hardening wave gate and reconcile the follow-ups list"
```

---

## Self-review notes

- **Spec coverage:** all 11 "Fix soon" items from PHASE1_FOLLOWUPS.md are covered (unescapeFormula→T1, preview diff→T2, weightGrams→T3, over-cap→T4, 23505+processing_error→T5, docblock→T5, .env.example→T6, PDP sanitise→T7, boundary guard→T8, integrations vitest→T6, leakage/lock→T10) plus handoff step 4 (secret scoping→T9). Known-limitations items are deliberately untouched except the secret split.
- **The `server-only` package is explicitly NOT used** — investigation showed it would crash the worker (plain Node, four import chains into the guarded files) and every vitest suite, and would break three legitimate client-component imports. Task 8's barrel move achieves the guard by construction instead.
- **Type consistency:** `changes: string[]` is defined in T2's csv.ts edit and consumed in the same task's panel edit. `description-policy.ts` exports exactly the two constants named in T8. `TLS_ASK_SECRET` is the name used in route, Caddyfile, .env.example, and turbo.json.
- **Order dependency:** T7 before T8 (PDP import). T10 last among code tasks (it touches test files other tasks extend). All other tasks are order-independent.
