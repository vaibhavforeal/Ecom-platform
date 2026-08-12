# Phase 1 completion — media pipeline, console CRUD, CSV import/export

Finishes Phase 1 of the multi-tenant commerce platform. Everything below is
additive to a codebase that is already green: `pnpm lint && pnpm typecheck &&
pnpm build && pnpm test && pnpm test:integration` all pass at the branch point
(148 unit tests, 42 integration tests, 2 Next apps building).

Architecture lives in `PLATFORM_BLUEPRINT.md`. Current state and the list of
traps already hit lives in `PROJECT_STATUS.md` — **every implementer must read
the "Traps already hit and fixed" section of `PROJECT_STATUS.md` before writing
code.** Those are bugs this project has already paid for once.

---

## Global Constraints

These bind every task. A violation is a defect regardless of what the task text
says.

1. **Multi-tenancy is not optional.** No tenant is ever hardcoded. Every data-plane
   query runs inside `withTenant(tenantId, …)` from `@platform/db`. Any new table
   carrying `tenant_id` is picked up automatically by `packages/db/src/rls.ts` and
   gets `FORCE ROW LEVEL SECURITY` + a `tenant_isolation` policy. A new table that
   must NOT be RLS-protected has to be added to the `PLATFORM_TABLES` allowlist
   **with a written justification** — the isolation suite fails the build otherwise.
2. **Vendor neutrality.** No provider name may appear in a branch, a conditional, or
   a type union outside its own adapter file. Cloudflare R2 is *a* storage driver,
   never *the* storage layer. Mirror the existing carrier pattern in
   `packages/integrations/src/carriers/define.ts`.
3. **Money is integer paise.** Never a float, never a rupee string. See
   `packages/core/src/catalog/money.ts`.
4. **Client-safe barrel split.** `@platform/core/catalog` is pure and importable
   from a client component. Anything touching the database, the filesystem, or a
   native module goes in a `/server` subpath. Breaking this fails `pnpm build`
   with an opaque `net`/`fs`/`perf_hooks` error.
5. **Relative imports are extensionless** repo-wide. Next cannot resolve ESM `.js`
   specifiers to `.ts` sources.
6. **Raw SQL fragments in a SELECT list must be `.as(...)` aliased**, and correlated
   references to an outer table must use a written-out fragment, not an
   interpolated column. Both traps produce silent NULLs with no error.
7. **`tx.execute` returns driver-level rows** — no camelCase mapping, no type
   decoding. A `timestamptz` arrives as a string whatever the annotation claims.
   Convert at the boundary.
8. **Ports are non-default on purpose**: Postgres 5442, PgBouncer 6442, Redis 6389.
   Do not "fix" them.
9. **Tests are required, and they must be able to fail.** Unit tests go in the
   package's `tests/`. Anything needing Postgres is an integration test
   (`*.integration.test.ts` in core, or `packages/db/tests/`). A test asserting
   only that a function did not throw is not a test.
10. **The full gate must pass before a task is DONE**: `pnpm lint && pnpm typecheck
    && pnpm build && pnpm test && pnpm test:integration`. `pnpm` is Corepack-only
    here — shims are installed at `$HOME/.pnpm-shim`; put that on PATH.
11. **New env vars must be added to `turbo.json`'s `globalEnv` and to
    `.env.example`**, or they are silently undefined in a Turbo-cached build.
12. **Anything that gates on `NODE_ENV === "production"` fails open.** If you add
    such a gate, the insecure branch must be the one that requires an explicit
    opt-in, not the default.

---

## Task 1: Per-tenant search indexing setting

**Problem.** A `trial` tenant is currently `noindex` in both `robots.txt` and page
metadata, derived from `tenant.status`. A trial merchant launching a real store
wants to be indexed, and a merchant upgrading from trial to active would today be
silently de-indexed-then-re-indexed by a billing event. Indexing must be an
explicit per-tenant decision, not a side effect of plan status.

**Schema.** Add to `tenants` (`packages/db/src/schema/tenancy.ts` — control plane,
correctly not RLS-protected):

```ts
searchIndexing: text("search_indexing").$type<SearchIndexing>().notNull().default("auto"),
```

Add to `packages/db/src/schema/enums.ts`:

```ts
export const SEARCH_INDEXING_MODES = ["auto", "indexed", "noindex"] as const;
export type SearchIndexing = (typeof SEARCH_INDEXING_MODES)[number];
```

Add a CHECK constraint using `sql.raw(sqlLiteralList(SEARCH_INDEXING_MODES))` —
DDL cannot contain bind parameters. Generate a migration with
`pnpm --filter @platform/db exec drizzle-kit generate` and verify it applies.

**Resolver.** Add a pure function to `packages/core/src/tenancy/` and export it
from `@platform/core`:

```ts
export function isSearchIndexable(tenant: {
  status: TenantStatus;
  searchIndexing: SearchIndexing;
}): boolean
```

Exact semantics, in this precedence order:

1. `status` of `"suspended"` or `"churned"` → **always `false`**. This is a
   platform safety decision and is NOT merchant-overridable — a suspended store
   must not stay in the index because someone set `indexed` before suspension.
2. `searchIndexing === "indexed"` → `true`.
3. `searchIndexing === "noindex"` → `false`.
4. `searchIndexing === "auto"` → `status === "active"`.

**Call sites.** Replace the status-derived checks with `isSearchIndexable(tenant)`:

- `apps/storefront/src/app/layout.tsx:23` (page metadata robots)
- `apps/storefront/src/app/robots.txt/route.ts:31`

Leave `sitemap.xml/route.ts` and `sitemaps/[page]/route.ts` alone: they already
gate on `suspended`/`churned` only, and a `noindex` store still legitimately
serves a sitemap. Do NOT change `apps/storefront/src/lib/tenant.ts:68` — that is
request-level access control, not SEO.

**Tests.** Unit-test the resolver as a truth table: all three modes × all tenant
statuses, asserting the exact boolean. Include explicitly that
`{status: "suspended", searchIndexing: "indexed"}` is `false` — that is the
override the precedence rule exists to prevent.

---

## Task 2: Storage adapter contract + local and S3-compatible drivers

**Problem.** The media pipeline needs somewhere to put bytes. Production is
Cloudflare R2; local development has no R2 and must not need one. Per Global
Constraint 2 this is an adapter contract with drivers, exactly like carriers.

**Location.** `packages/integrations/src/storage/`.

**Contract.** Define in `@platform/core` (types only, so the contract is not
owned by the integrations package):

```ts
export type StoredObject = { key: string; byteSize: number; contentType: string };

export type StorageAdapter = {
  readonly driver: string;
  put(key: string, body: Buffer, opts: { contentType: string; cacheControl?: string }): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Public URL if the driver serves one; null when the app must proxy. */
  publicUrl(key: string): string | null;
};
```

**Drivers.**

- `local` — filesystem, rooted at `MEDIA_LOCAL_ROOT` (default
  `<repo-root>/.media`). For development. **Must reject any key that escapes the
  root after normalisation** — path traversal here is arbitrary file write. Test
  this explicitly with `../` and absolute-path keys.
- `s3` — S3-compatible, driving R2, S3, MinIO and Backblaze through the same code.
  Config from `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`,
  `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`. Use `@aws-sdk/client-s3`.
  The driver name is `s3`, not `r2`.

**Selection.** `getStorage()` reads `STORAGE_DRIVER` (`local` | `s3`), defaulting
to `local`. **In production, defaulting is forbidden**: if `NODE_ENV === "production"`
and `STORAGE_DRIVER` is unset, throw at startup rather than silently writing a
production catalog's images to a container-local filesystem that vanishes on
redeploy. This is the fail-open trap from Global Constraint 12 — the safe branch
is the default, and the unsafe one must be chosen explicitly.

**Key generation.** A pure helper in `@platform/core/media`:

```ts
export function mediaStorageKey(input: { tenantId: string; checksum: string; ext: string }): string
export function derivativeStorageKey(input: { tenantId: string; checksum: string; width: number; format: string }): string
```

Keys are tenant-prefixed (`<tenantId>/originals/<checksum>.<ext>` and
`<tenantId>/d/<checksum>/<width>.<format>`). Tenant-prefixing is what makes a
per-tenant bulk delete a prefix operation and makes a leaked key obviously
cross-tenant. Reject any `ext`/`format` not in an allowlist — these end up in a
filesystem path.

**Tests.** Unit tests against the `local` driver (round-trip, overwrite, delete,
exists, traversal rejection) and pure-function tests for key generation. Do not
write tests requiring live S3 credentials; test the `s3` driver's key/config
construction only.

**Env.** Add every new var to `turbo.json` `globalEnv` and `.env.example`.

---

## Task 3: Image processing pipeline — upload endpoint and worker job

**Problem.** `media` rows, the `derivatives` jsonb shape, `IMAGE_WIDTHS`, and the
storefront's `srcset`/`sizes` rendering already exist and are already wired.
Nothing populates them. This task builds upload → validate → store original →
enqueue → derive → update row.

Read `apps/storefront/src/lib/media.ts` first — it defines `IMAGE_WIDTHS`
(320/480/640/960/1280/1920), the `MediaDerivative` shape
(`{format, width, height, storageKey, byteSize}`), and the formats
(`avif` | `webp` | `jpeg`). **The written rows must match that shape exactly**, or
the storefront silently renders no images.

**Pure logic** → `packages/core/src/media/` (client-safe, no sharp, no db):

- `planDerivatives(original: {width, height}): {format, width}[]` — never upscale
  past the original's intrinsic width, and always include the smallest width even
  for a tiny original so `srcset` is never empty.
- `validateUpload({mimeType, byteSize, bytes})` — allowlist `image/jpeg`,
  `image/png`, `image/webp`, `image/avif`. **Sniff magic bytes; never trust the
  declared Content-Type or the filename extension.** Cap at 10 MB.
- `sha256(bytes)` for the checksum/dedupe key.

**Worker job** → `apps/worker/src/jobs/process-media.ts`, plus a `media` queue in
`apps/worker/src/queues.ts` following the existing `TenantJob` contract (payload
carries `tenantId`; the handler's first act is `withTenant`).

Uses `sharp`. It must:

- `sharp(bytes, { limitInputPixels: 50_000_000 })` — an unbounded decode is a
  decompression bomb: a 4 KB PNG can expand to gigabytes of RAM and kill the
  worker for every tenant at once.
- **Strip metadata by default.** Merchant phone photos carry GPS EXIF; publishing
  a merchant's home coordinates on their product page is a privacy breach. Rotate
  per EXIF `Orientation` *before* stripping, or portrait photos come out sideways.
- Write derivatives via the Task 2 storage adapter, then update the `media` row to
  `status = "ready"` with the `derivatives` array and the original's
  `width`/`height`.
- On failure set `status = "failed"` and `processingError`, and rethrow so BullMQ
  records the failure. Never leave a row `pending` forever.

**Upload endpoint** → `apps/console/src/app/api/media/upload/route.ts`. Session-
authenticated (mirror the existing console API routes and
`apps/console/src/lib/session.ts`). It must:

- Resolve the tenant from the session, never from the request body.
- Validate before storing.
- Compute the checksum and **dedupe**: if a non-deleted `media` row already exists
  for `(tenantId, checksum)`, return it instead of reprocessing. The unique index
  `media_tenant_checksum_idx` is already there for this.
- Insert the row `status = "pending"`, store the original, enqueue the job, return
  the media id.

**Tests.** Unit-test `planDerivatives` (including the no-upscale rule and the
tiny-original case) and `validateUpload` (each allowed type by magic bytes; a
PNG renamed `.jpg` accepted on its real type; an HTML file declared `image/png`
rejected; an oversize file rejected). Integration-test the worker job end to end
against Postgres and the `local` driver: a real small PNG in, `status = "ready"`
and derivative objects actually readable back out.

---

## Task 4: HTML sanitiser + console product CRUD

**Problem.** The PDP renders `description` as plain text deliberately: injecting
merchant HTML unsanitised is stored XSS against that merchant's own customers, on
a page that will later collect addresses and payments. And there is no console UI
to create a product at all — the catalog is seed-only today.

**Sanitiser** → `packages/core/src/catalog/sanitize-html.ts`, pure and client-safe,
exported from `@platform/core/catalog`.

- **Allowlist**, never a blocklist: `p, br, strong, em, u, ul, ol, li, h2, h3, h4,
  a, blockquote`. Attributes: `href` on `a` only.
- On `a`, permit only `http:`, `https:` and `mailto:` URLs — reject `javascript:`,
  `data:`, and protocol-relative `//evil.com`. Force `rel="nofollow noopener"` and
  `target="_blank"` on outbound links.
- Strip everything else, including all `on*` handlers, `<style>`, `<script>`,
  `<iframe>`, and comments.
- Use a maintained library (`sanitize-html` or `dompurify` + `jsdom`) rather than a
  hand-rolled regex parser. A regex HTML sanitiser is a CVE with a wait time.
- **Sanitise on write, in the console**, and store the sanitised HTML. Storing raw
  and sanitising on read means every future reader has to remember.

Then let the PDP render the sanitised description as HTML.

**Console CRUD** → `apps/console/src/app/products/`.

- List: paginated, searchable, tenant-scoped, showing status and price.
- Create/edit: title, slug, description (rich), status, options and the variant
  matrix, per-variant SKU/price/stock, media attach with alt text, category and
  collection membership.
- Slug edits must go through the existing slug-history mechanism in
  `@platform/core/catalog/slug.ts` so the old URL keeps permanently redirecting.
  Do not write `url_slugs` by hand.
- Every mutation writes an `audit_log` row (`packages/core/src/audit/`) and runs
  inside `withTenant`.
- Server Actions or route handlers — match whatever the console already does.
  Validate every input with `zod` at the boundary; never trust a form field.

**Tests.** Unit-test the sanitiser hard: `<script>`, `javascript:` href,
`onerror=`, `<img src=x onerror=alert(1)>`, protocol-relative URL, nested
malformed tags, and that permitted formatting genuinely survives. Integration-test
create → edit → slug change → old slug still redirects.

---

## Task 5: Bulk CSV import/export

**Problem.** A merchant onboarding with an existing catalog will not retype it.
This is the migration path onto the platform.

**Pure logic** → `packages/core/src/catalog/csv.ts` (client-safe): column mapping,
row → product/variant parsing, and a validation pass that returns structured
errors keyed by row number and column.

**Rules.**

- One row per **variant**; the product is identified by a `handle` column repeated
  across its variant rows. This is the shape merchants export from other platforms,
  so it is the shape that can be pasted in.
- Prices in the CSV are **rupees** (that is what a merchant types); convert to
  integer paise on the boundary with the existing money helpers. A price that does
  not parse is a row error, never a silent zero — a product accidentally listed at
  ₹0 is real money lost.
- **Dry-run by default.** The import returns a report — created / updated /
  skipped / errored, with per-row reasons — and only commits when explicitly
  confirmed. Import the whole file in one transaction so a failure halfway does
  not leave half a catalog.
- Cap the row count and file size; stream rather than buffering the whole file.
- Export is the exact inverse: a file exported and re-imported unchanged must be a
  no-op. Test that round-trip explicitly.

**Console UI** → upload with a preview of the dry-run report, and a download that
streams the tenant's catalog as CSV.

**Tests.** Unit-test parsing and validation against a fixture CSV including a
malformed price, a missing required column, a duplicate SKU, and a UTF-8 BOM (Excel
writes one, and it silently corrupts the first column name). Integration-test the
round-trip no-op.
