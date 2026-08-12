# Project Status

**Last updated:** 2026-08-13

Working notes for picking this up after a break. Architecture lives in
[`PLATFORM_BLUEPRINT.md`](./PLATFORM_BLUEPRINT.md); day-to-day commands live in
[`README.md`](./README.md). This file is only "where were we".

---

## Where things stand

| Area | State |
| :--- | :--- |
| **Phase 0 — Foundations** | ✅ Complete and verified end to end |
| **Multi-carrier logistics** | ✅ Framework complete; vendor HTTP transport deliberately not written |
| **Phase 1 — Catalog & Storefront** | ✅ Complete — merged to `master` 2026-08-13 (`b219e4f`). See the piece-by-piece table below |

### Phase 1 progress

| Piece | State |
| :--- | :--- |
| Per-tenant search indexing | ⚠️ `tenants.search_indexing` (`auto`/`indexed`/`noindex`) + `isSearchIndexable`, read by `robots.txt` and page metadata. **No route and no console screen writes the column** — it is SQL-only until a settings UI exists |
| Catalog schema + RLS + seed | ✅ 11 tables, policies auto-derived, demo catalog for both tenants |
| Catalog domain logic (`@platform/core/catalog`) | ✅ slugs, option matrices, money, search, category trees |
| Storefront query layer | ✅ listing, PDP, slug resolution, sitemap — integration tested |
| Storefront pages | ✅ home, category, collection, PDP, search — verified over HTTP |
| SEO surface (JSON-LD, sitemap, canonicals, redirects) | ✅ verified over HTTP |
| Media pipeline | ✅ Upload endpoint + worker job — validate, dedupe, AVIF/WebP/JPEG ladder; cards and the PDP hero serve the ladder, `(tenant_id, checksum)` is unique |
| HTML sanitiser | ✅ Allowlist, applied on write; the PDP now renders rich descriptions |
| Console catalog CRUD | ✅ Products, variants, options, media attach, categories, collections, slug history |
| Bulk CSV import/export | ✅ One row per variant, dry-run by default, whole file in one transaction, export is the exact inverse |
| Storefront cache purge | ✅ Console POSTs the storefront's internal `/api/internal/revalidate` after every committed catalog write, with tenant-prefixed tags; the worker purges too, once a media row goes `ready`. Fail-soft — a failed purge never fails the write. A no-op CSV import does not purge |
| Next 16 upgrade (both apps) | ✅ 16.3.0 on Turbopack. Forced by Next 15.3–15.5 writing the tag manifest only on a tag's FIRST purge, which made every catalog edit after the first wait out the 300s TTL |

### Verified live on 2026-08-01

Served a production build and checked over HTTP (port 3010; something else
on this machine holds 3000):

- `acme.localhost` → Acme's 3 products at correct rupee prices; `globex.localhost`
  → Globex's 3. Unknown host → 404. Acme's slug on Globex's host → 404.
- PDP emits `Product` + `Offer` (bare decimal `"1299.00"`, INR) and
  `BreadcrumbList`; canonical and templated `<title>` present.
- `robots.txt` per host — Acme (active) allows and points at its own sitemap;
  Globex (trial) is `Disallow: /`.
- `sitemap.xml` lists only that tenant's canonical URLs with `lastmod`.
- Superseded slug → permanent redirect to the canonical one.
- Search stems: `?q=shirts` finds "Classic Cotton Shirt"; page is `noindex, follow`.

### Verified live on 2026-08-12 (console CRUD + sanitiser)

Production builds of both apps, console on 3001 and storefront on 3010, a real
staff session and the seeded `acme` tenant:

- `/products`, `/products/new`, `/products/taxonomy` and `/products/{id}` all
  render; the list shows the seeded catalog at correct rupee prices, and
  `?q=` and `?status=` filter it. Unauthenticated → 307 to `/login`.
- `POST /api/products` → 201; `PUT /api/products/{id}` twice, renaming the slug
  each time. Both superseded slugs 308-redirect straight to the current
  canonical one — no chain.
- A description containing `<script>`, `<img onerror>` and a `javascript:` href
  came back from the PDP as `<p>Wash <strong>cold</strong>, dry <em>flat</em>.</p>`
  plus the list, with the hostile link reduced to `<a>bad link</a>` and the
  legitimate one carrying `rel="nofollow noopener" target="_blank"`.
- **The redirect and the new description only appeared after the storefront was
  restarted** — see the cache-purge item under Open items. That is a gap, not a
  bug in the write path.

**Not an open question — a missing screen.** A `trial` tenant defaults to
`noindex` in both `robots.txt` and page metadata, and Task 1 already built the
way out: `tenants.search_indexing` is `auto` | `indexed` | `noindex`, and
`isSearchIndexable` reads it, so a trial merchant launching a real store can be
indexed by setting the column to `indexed`. `suspended` and `churned` stay
`noindex` whatever the column says — that ordering is deliberate and tested.

What is missing is the way to set it: **nothing in the repo writes that
column.** No route, no console screen, no seed value other than the `auto`
default. So the setting exists and works, but is reachable only by SQL until a
tenant-settings UI exists.

### Last full verification (2026-07-31, all green)

```
typecheck                6/6 packages
@platform/core          73 tests
@platform/integrations  13 tests
@platform/db            17 tests   (tenant isolation, needs Postgres)
```

Live checks that passed the same day:

- `acme.localhost:3000` → Acme Retail · `globex.localhost:3000` → Globex Trading · unknown host → **404**
- Phone OTP login: wrong code → 401, correct code → session + audit row
- Unauthenticated console → 307 to `/login`
- TLS `ask` gate: verified domain → 200, `attacker.com` → 403, bad secret → 403
- OTP burst limit: 2nd request within 45s → 429
- `app_user` DELETE on `audit_log` → `permission denied`

### Re-verified 2026-08-01 (full, all green)

Docker was brought back up and the whole sequence re-run, then re-run again
after the Phase 1 work below:

```
pnpm lint                clean
pnpm typecheck           6/6 packages
pnpm build               2/2 Next apps      (this had NEVER passed — see traps)
pnpm test                148 unit tests     (core 135, integrations 13)
pnpm test:integration     42 tests          (db isolation 20, catalog queries 22)
```

### Re-verified 2026-08-12 (after bulk CSV, full, all green)

```
pnpm lint                clean
pnpm typecheck           6/6 packages
pnpm build               2/2 Next apps
pnpm test                317 unit tests     (core 273, integrations 44)
pnpm test:integration    127 tests          (console 79, core 22, db 20, worker 6)
```

### Re-verified 2026-08-12 (after the cache purge endpoint, full, all green)

```
pnpm lint                clean
pnpm typecheck           6/6 packages
pnpm build               2/2 Next apps
pnpm test                321 unit tests     (core 277, integrations 44)
pnpm test:integration    146 tests          (console 89, core 22, db 20, storefront 9, worker 6)
```

### Re-verified 2026-08-12 (after serving derivatives + the unique checksum index, full, all green)

```
pnpm lint                clean
pnpm typecheck           6/6 packages
pnpm build               2/2 Next apps
pnpm test                321 unit tests     (core 277, integrations 44)
pnpm test:integration    159 tests          (console 89, core 25, db 24, storefront 15, worker 6)
```

### Re-verified 2026-08-13 (after the Next 16 upgrade, full, all green)

```
pnpm lint                clean
pnpm typecheck           6/6 packages
pnpm build               2/2 Next apps      (Next 16.3.0, Turbopack)
pnpm test                321 unit tests     (core 277, integrations 44)
pnpm test:integration    167 tests          (console 89, core 25, db 32, storefront 15, worker 6)
```

Unit counts are identical to the run before it. Integration went **159 → 167**,
and the +8 are NOT from the upgrade: they are the `packages/db` suite
`media-dedupe-migration.test.ts`, added by commit `b940b00` between the two runs
(db 24 → 32). Every other package's count is unchanged.

The upgrade's own test change was a replacement, not an addition: the
`KNOWN DEFECT` characterisation test in
`apps/storefront/tests/cache-purge.integration.test.ts` failed on the upgrade,
which was the point, and was replaced by one asserting that the second and third
purge of a tag are both honoured.

Live pass on production builds (storefront 3010, console 3001): per-host
catalogs correct, unknown host 404, each tenant's slug 404 on the other's
host, unauthenticated console 307 → `/login`, and **three consecutive
console writes each visible on the storefront within a second**. Control:
a title written straight into Postgres, with no purge, stayed invisible
until a purge was sent — so the cache was genuinely caching.

### Re-verified 2026-08-13 (after the whole-branch review fix wave, full, all green)

```
pnpm lint                clean
pnpm typecheck           6/6 packages
pnpm build               2/2 Next apps      (Next 16.3.0, Turbopack)
pnpm test                321 unit tests     (core 277, integrations 44)
pnpm test:integration    174 tests          (console 93, core 25, db 32, storefront 15, worker 9)
```

Unit counts unchanged; integration **167 → 174**. The +7 are new: console +4
(a failed-media re-upload retry, the alt returned on a dedupe hit, `alt: null`
leaving a shared alt alone, and a committed no-op import not purging) and
worker +3 (the job purges when a row goes `ready`, does not purge when it
fails, and does not fail when the purge does).

Each fix was probed by reverting it and watching its own test fail, then
restored: the two storefront purge tests now fail under
`revalidateTag(tag, "max")` where before the change they passed; the no-op
purge test fails without the `created + updated > 0` guard; the worker purge
test fails without the purge call; the failed-media retry test fails against
the old dedupe SELECT.

**No live HTTP pass was run for this wave** — the gate above is the whole
of it. The live pass recorded under the Next 16 section still stands for
the purge path it covers.

`apps/storefront` gained a test surface for the first time, so it now has the
same `tsconfig.json` / `tsconfig.test.json` split as `apps/console` — tests must
stay out of what `next build` typechecks, or a production install without
devDependencies fails the build.

The Postgres volume survived the restart: both demo tenants (`acme`, `globex`) and
their `.localhost` domains are still seeded. `users` is empty, so the staff row for
console login needs re-adding with the SQL in the README before the console is usable.

**`pnpm` is not on the PATH in a plain shell here.** Node is installed but pnpm ships
only through Corepack. Either `corepack pnpm …`, or install shims once with
`corepack enable --install-directory <dir> pnpm` and put that dir on PATH. Nested
package scripts (`pnpm --filter …`) need the shim on PATH — `corepack pnpm` alone
fails on the inner call.

---

## First thing to do after restart

```bash
pnpm infra:up            # needs Docker Desktop running
pnpm db:migrate          # re-applies RLS policies idempotently
pnpm test:integration    # the 20-test isolation suite, and everything else
```

If the database volume survived, the two demo tenants are still seeded. If not:
`pnpm db:seed`, then re-add yourself as staff using the SQL in the README.

---

## Decisions already made — do not relitigate

1. **Multi-tenant from day one.** A store is a row in `tenants`. Nothing about any
   single merchant is hardcoded anywhere. This is what makes the SaaS phase a
   signup form rather than a rewrite.
2. **Generic platform.** `Digital_Showroom_Documentation.md` is *reference input
   only* — a feature checklist. No specific business, domain or competitor
   migration belongs in the code or docs.
3. **BYOG payments.** Merchants connect their own gateway; funds never touch the
   platform. Avoids RBI Payment Aggregator licensing and GST s.52 TCS/GSTR-8.
   Still needs CA + lawyer confirmation.
4. **Stack/hosting.** Next.js + TypeScript + PostgreSQL on VPS + Docker.
5. **Ports are non-default on purpose** — Postgres `5442`, PgBouncer `6442`,
   Redis `6389`. Another project on this machine holds 5432. Do not "fix" these.

---

## Traps already hit and fixed — do not reintroduce

- **RLS policies need `NULLIF`.** Without it, a context-free query raises a uuid
  cast error instead of returning zero rows — and only once the connection pool
  warms up, so it is a production-only failure.
- **`FORCE ROW LEVEL SECURITY` is mandatory.** Plain `ENABLE` is bypassed when
  the connecting role owns the table.
- **Tenant scoping is driven by the `PLATFORM_TABLES` allowlist**, not by "has a
  `tenant_id` column". Several control-plane tables have that column but must not
  be RLS-protected, or login and hostname resolution break.
- **DDL cannot contain bind parameters.** CHECK constraints use
  `sql.raw(sqlLiteralList(...))`.
- **Ambiguous RTO text maps to `rto_initiated`, never `rto_delivered`.** Calling
  an RTO complete early restocks in-transit stock and causes oversell.
- **Next cannot resolve ESM `.js` specifiers to `.ts` sources.** Relative imports
  are extensionless repo-wide.
- **Next only reads `.env` from its own app directory** — both Next apps go
  through `dotenv-cli` pointed at the repo root.
- **Drizzle renders a column UNQUALIFIED inside a SELECT-list expression.** In a
  correlated subquery, interpolating `products.id` emits `v.product_id = "id"`,
  which Postgres resolves against the *subquery's* own table — so the condition is
  `v.product_id = v.id`, never true, and the column is NULL on every row with no
  error. Correlated references use the written-out `OUTER_PRODUCT_ID` fragment.
  (WHERE-clause interpolation *is* qualified; the difference is the trap.)
- **Un-aliased raw SQL in a SELECT comes back named `?column?`.** Several in one
  query collide into a single result key and silently read as null. Every raw
  fragment gets `.as(...)`.
- **`tx.execute` returns driver-level rows** — no camelCase mapping, no type
  decoding, so a `timestamptz` arrives as a *string* however it is typed. Convert
  at the boundary rather than trusting the annotation.
- **`.env` set `NODE_ENV=development`, and the Next build scripts pipe `.env`
  through `dotenv-cli`** — so `next build` ran with a development NODE_ENV and
  died prerendering `/404` with the unrelated-looking "`<Html>` should not be
  imported outside of `pages/_document`". `pnpm build` had never worked for
  either Next app. Fixed by overriding in the script (`dotenv -v
  NODE_ENV=production`) rather than deleting the var: `session.ts`,
  `otp-delivery.ts` and the carrier registry all gate on
  `NODE_ENV === "production"` and **fail open**, so an unset value would ship
  insecure cookies, log OTPs and expose the `fake` carrier.
- **Next's full-route cache is keyed by pathname, NOT by Host.** Statically
  generating `/white-shirt` would serve one tenant's page on another's domain.
  Every storefront route is `force-dynamic`; the database work is cached with
  `unstable_cache` keyed by tenant id, and edge caching is Cloudflare's job
  (a CDN keys on host + path).
- **A client component importing `@platform/core/catalog` used to drag in the
  postgres driver** and fail the build on `net`/`fs`/`perf_hooks`. The barrel is
  split: `@platform/core/catalog` is pure and client-safe,
  `@platform/core/catalog/server` holds everything that touches the database.
- **ESM evaluates imports before the importing module's body**, so
  `config({ path: ... })` at the top of `apps/worker/src/index.ts` ran
  *after* `queues.ts` had already read `REDIS_URL` and built its client.
  The worker had been connecting to the default `localhost:6379` — a port
  nothing listens on — and retrying forever, logging `worker.error` with
  an empty message. Fixed by moving the dotenv call into
  `apps/worker/src/env.ts` and making `import "./env"` the first import.
  It only works while it stays first.
- **A relative `MEDIA_LOCAL_ROOT` resolves against each process's own
  cwd**, so the console would write uploads to `apps/console/.media` and
  the worker would look in `apps/worker/.media`. Left unset, both resolve
  the built-in `<repo-root>/.media`. If it is ever set, set it absolute.
- **Media derivatives must be recorded at their ACTUAL output size**, not
  at the width they were planned for. A 100px logo is planned at 320 and
  rendered at 100 (`withoutEnlargement`); a `320w` descriptor on a 100px
  file makes the browser pick it for a 320px slot and render it blurry.
- **`permanentRedirect()` emits 308, not 301.** Google treats them as
  equivalent, so this is fine — but the domain layer now returns
  `permanent: true` rather than claiming a status code it does not control.
- **A foreign key does NOT enforce tenancy.** PostgreSQL validates
  referential integrity as the table owner, with row security bypassed —
  so a `media_id` belonging to another merchant satisfies the FK and
  attaches cleanly, with nothing to see in the logs. RLS does not close
  this. Every id a payload names is checked with an explicit SELECT
  inside `withTenant` before it is written (`assertVisible` in
  `catalog/writes.ts`); there is an integration test for it.
- **`sanitize-html` pulls in `postcss`, which reads `fs`.** It lives in
  the client-safe `@platform/core/catalog` barrel because the module
  itself is pure, and webpack tree-shakes it out of both apps' client
  bundles — verified by grepping `.next/static/chunks`. A client
  component that imported `sanitizeDescriptionHtml` would fail the build,
  which is the right failure: nothing needs it in a browser.
- **`product_variants` has two PARTIAL unique indexes** over
  `deleted_at IS NULL` — one on SKU, one on the option combination. A
  save that swaps two variants' SKUs collides mid-UPDATE if the rows are
  edited in place. The write layer soft-deletes every live variant first
  and then revives the ones being kept, so the indexes only ever see the
  set being written.
- **A variant is identified by its id, and failing that by its SKU.**
  Without the SKU fallback a payload that omits ids — which is every CSV
  row — soft-deletes and re-creates the whole variant set: no visible
  change in the catalog, and every Phase 2 order line left pointing at a
  dead row.
- **`publishedAt` must be set on the first activation.** The storefront
  orders listings by `desc(published_at)` and PostgreSQL sorts NULLs
  FIRST under DESC, so an active product without one pins itself to the
  top of every page.
- **`slugify` FALLS BACK rather than failing.** `slugify("!!!")` is
  `"item"`, and `{ fallback: "" }` does not change that — the function
  ends `slug || opts.fallback || "item"`, so an empty fallback is
  falsy. A CSV importer that trusted it would turn every
  punctuation-only handle into one product living at `/item`. Test
  sluggability with `/[\p{L}\p{N}]/u` *before* calling it.
- **`String.prototype.trim()` removes U+FEFF.** ECMAScript counts the
  BOM as WhiteSpace, so a BOM left on the first header name is silently
  fixed by any `.trim()` downstream — which makes it very easy to write
  a BOM test that passes with the BOM handling deleted. `csv.ts` strips
  it in the reader and the test asserts against the READER, not against
  the parsed column names.
- **`Response.text()` strips a leading BOM** (it is a spec "UTF-8
  decode"). Asserting that the CSV export writes one has to be done on
  `arrayBuffer()` bytes, or the assertion is vacuous.
- **A CSV cell beginning `=`, `+`, `-` or `@` is a FORMULA to Excel**,
  and CSV quoting does not stop it — the quotes are syntax the
  spreadsheet strips before deciding. The export prefixes an apostrophe
  and the import strips exactly one, which is a bijection, so the
  round-trip no-op survives the guard.
- **Export must be the exact inverse of import, including what it does
  NOT rebuild.** Deriving a product's option axes from the rows in the
  file drops any declared axis value no variant sits at (Size S/M/L with
  only S and M stocked), so a re-imported export would not be a no-op.
  The importer grows axes and never prunes them.
- **The CSV path bypasses `catalog-input.ts`, so every cap that schema
  applies is `csv.ts`'s job** — including the two that are not about a
  single cell: 200 variants per product and 50 values per option axis.
  Miss those and the importer happily creates a product the console's
  own edit form then refuses to save, with nothing on screen explaining
  why. **And the unit those two have to be enforced on is the MERGED
  product, not the file.** `mergeProduct` appends the stored variants a
  file does not mention and `mergeAxes` unions its option values onto
  the stored ones, so a cap checked only against the file is reachable
  in two imports that are each under it — fifty values, then five more.
  `bulk.ts` re-checks both after merging; `csv.ts` keeps the file-level
  check only so the common case is refused before a transaction opens.
- **`revalidateTag` only clears the CALLING process's cache.** Next's
  tag manifest is a module-level `Map`, so the console cannot purge the
  storefront's cache however it calls the function. Hence
  `POST /api/internal/revalidate` on the storefront. The same fact caps
  the design: one purge reaches ONE storefront process, so more than one
  replica needs a load balancer that fans the purge out, or those
  replicas wait out the TTL.
- **Next 15.3–15.5 ignore every `revalidateTag` on a tag after the
  first.** `FileSystemCache.revalidateTag` guarded its write with
  `if (!tagsManifest.has(tag))`, so the manifest kept the timestamp of
  the first purge forever. Staleness was `revalidatedAt >= entry.lastModified`,
  and an entry re-cached after that first purge always has a later
  `lastModified` — so it was never evicted again. **Fixed by moving to
  Next 16** (Task 8), which holds `{stale, expired}` objects and writes
  them unconditionally. Do not go back to the 15 line; the test that
  used to pin the defect now pins the fix.
- **Next 16 made `revalidateTag`'s second argument mandatory, and the
  value its own deprecation notice recommends silently breaks the
  purge.** The notice says to pass `"max"` or switch to `updateTag`.
  `updateTag` throws outside a Server Action, so a route handler cannot
  use it at all. And a named `cacheLife` profile sets
  `expired = now + profile.expire` — a year out for `"max"` — where a
  purge wants `expired = now`; only `expired` evicts. `areTagsStale`
  merely sets `isStale`, and on a **dynamic** render `unstable_cache`
  returns a stale entry to the caller and refreshes it in the
  background — so a profile purge answers 200 and the next visitor still
  gets the old page. Measured over three write-then-purge rounds on one
  tag: `{expire: 0}` → `Title 1 | Title 2 | Title 3`; `"max"` and
  `{expire: 60}` → `Title 0 | Title 1 | Title 2`, one behind throughout.
  The purge endpoint passes `{ expire: 0 }`.
- **Next compares the tag manifest against TWO DIFFERENT CLOCKS.**
  `FileSystemCache.revalidateTag` writes `expired` from `Date.now()`, and
  `FileSystemCache.set` writes `lastModified` from `Date.now()` — but
  `areTagsExpired` tests `expiredAt <= performance.timeOrigin +
  performance.now()`. `performance.timeOrigin` is fixed when the process
  starts, so its offset from the wall clock is per-process and drifts;
  measured in one vitest worker at **-0.699ms to +0.301ms**, and in a
  plain `node` process at **+0.714ms to +1.259ms**. When it is negative,
  a purge issued at `Date.now() = T` does not read as expired until the
  performance clock passes `T`. Called in the same instant as the purge,
  `areTagsExpired` returned false **70% of the time** (20,000 samples);
  `areTagsStale`, which reads no clock at all, was never false.
  **Production is not exposed** — a purge arrives over HTTP from the
  console and the next visitor is a network round trip behind it, not
  microseconds — but a same-process test lands inside the window
  constantly. It made the purge regression test fail 9 runs in 30 at
  whichever round lost the race, and adding console I/O hid it
  completely. Tests put a gap between a purge and the read that checks
  it. Do not "reason" about this one from a single measurement: the sign
  of the skew differs between processes, which is exactly how it was
  first misdiagnosed.
- **A cached read in a test is not a cached read in a render.**
  `unstable_cache` branches on whether a work store is present. Outside
  one — a bare `await getCachedProduct(...)` — a stale entry is
  recomputed SYNCHRONOUSLY and the caller gets fresh data. Inside one,
  with `isStaticGeneration: false`, the stale entry is returned as-is.
  So a purge that only marks a tag stale passes a naive test and ships
  the bug. `tests/next-cache-harness.ts` exposes `runDynamicRender` for
  this, and any assertion of the form "the visitor now sees the new
  value" has to go through it.
- **`next lint` no longer exists in Next 16**, and `next build` no longer
  lints. Both apps' `"lint": "next lint"` scripts were removed; the root
  `pnpm lint` (`eslint .` over the whole workspace) is and always was the
  thing that actually ran. There is no `eslint-config-next` in this repo
  and none was added — the shared flat config in `@platform/config` is
  the lint surface.
- **Turbopack is the default bundler for `next build` in 16.** Neither
  app has a `webpack` key in `next.config.ts`, so nothing needed
  `--webpack`. One behaviour difference: a client component importing
  `sanitizeDescriptionHtml` used to fail the webpack build on `fs`;
  under Turbopack it builds and drags `sanitize-html` into the client
  chunk instead. Nothing does that today — the shipped chunks were
  grepped — but the guard is now a bundle-size regression rather than a
  build error. The `fs`/`net`/`tls`/`perf_hooks` failure for
  `@platform/core/catalog/server` is unchanged and still hard; both
  directions were probed.
- **A purge must be issued AFTER the transaction commits.** One issued
  from inside can race a storefront reader into re-caching the
  pre-commit row, and that entry then lives out its full TTL instead of
  expiring — strictly worse than the stale cache it was meant to fix.
  The console test asserts this by reading the row on an independent
  connection at the moment the purge arrives.
- **A bound string parameter cast straight to `::jsonb` stores a jsonb
  STRING — on a bare `postgres()` client.** `ParameterDescription`
  backfills the server-inferred OID (3802) into the statement, and
  postgres.js's serializer for that OID is `JSON.stringify` — so
  `${JSON.stringify(x)}::jsonb` writes `"[{…}]"`, a jsonb string that
  spells an array rather than the array. **Drizzle is not saved by
  sending text; it sends the same string** (`PgJsonb.mapToDriverValue`
  is `JSON.stringify`). What saves it is that `drizzle(client)` MUTATES
  the client, swapping `options.serializers["114"]` and `["3802"]` for
  an identity function. The deciding factor is which client object you
  hold, not the encoding — and test fixtures hold a bare one. Reading
  the row back through Drizzle hides the damage (its jsonb decoder
  parses a string value), but `jsonb_build_object` nests it as a string
  and the storefront then finds no derivatives on a row that looks
  correct in psql. Fixtures bind `::text::jsonb`.
- **Drizzle's migrator runs every pending migration inside ONE
  transaction.** So `CREATE INDEX CONCURRENTLY` is illegal in a migration
  file — the unique checksum index de-duplicates first instead, which is
  atomic with the DDL that follows it. And a migration touching a
  tenant-scoped table only sees rows because `app_migrator` has
  BYPASSRLS: without it a data-repair step finds nothing, reports
  nothing, and succeeds. That migration asserts the role can bypass RLS
  rather than trusting it.
- **A source file containing a raw NUL byte is BINARY to git, and its
  diffs vanish from review.** `resolve.ts` held `const NEGATIVE = "\0none";`
  written as one literal 0x00 byte rather than the escape. `file`
  reported `data`, and every diff of that file rendered as
  `Bin 6235 -> 6333 bytes` — no lines, nothing to review, and `git merge`
  treats it as an unmergeable binary conflict. It was the module deciding
  which merchant's catalog a hostname serves. `"\u0000none"` is the same
  runtime value (`length === 5`, `charCodeAt(0) === 0`) in ASCII source
  bytes. Git decides this per blob and caches nothing: the diff against
  the last binary revision is still binary, and everything after it is
  text.
- **A blank cell states NOTHING — including `variant_active`.** Every
  product column already worked that way, but the variant flag defaulted
  a blank to `true`, so a file that merely carried the column put a
  variant the merchant had switched off back on sale, with nothing in
  the report saying so (`ImportReport` holds counts and per-row issues,
  not a field-level diff). "Cleared" is harmless for `barcode`; here it
  meant "buyable".

---

## Open items

| Item | Why it matters | Lead time |
| :--- | :--- | :--- |
| CA + lawyer sign-off on BYOG payments | Decides the entire commercial structure of the SaaS phase | Start now |
| TRAI DLT registration (SMS) | Carriers silently drop unregistered traffic; blocks Phase 4 | Weeks |
| WhatsApp Business verification | Blocks Phase 4 messaging | Weeks |
| Ekart partner agreement | API docs and credentials are gated behind a Flipkart commercial agreement | Unknown |
| ~~Storefront cache purge — blocked on a Next defect~~ | **Closed by Task 8**: both apps are on Next 16.3.0, where the tag manifest is written unconditionally. Verified live — three consecutive console writes on the same tenant each appeared on the storefront within a second, with the 300s TTL never waited on. The remaining limitation is unchanged and is a deployment fact, not a bug: one purge reaches ONE storefront process, so more than one replica needs a load balancer that fans the purge out, or a shared cache handler | Done |
| Stock levels | The console can set a variant's SKU, price and low-stock threshold but not its quantity — there is no `stock_movements` table yet. The inventory ledger is Phase 2 (blueprint §4.5), and a mutable counter would be the wrong thing to add early | Phase 2 |

---

## Phase 1 scope, when resuming

Products, variants, options, categories, collections · bulk CSV import/export ·
media pipeline (upload → resize → AVIF/WebP → object storage → CDN) · storefront
home/category/PDP · Postgres FTS search · SEO: JSON-LD, meta management, sitemap,
canonicals, slug history with 301s.

**Exit criterion:** a full catalog live on a staging domain, passing Google's
Rich Results Test.
