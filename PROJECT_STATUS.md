# Project Status

**Last updated:** 2026-08-01

Working notes for picking this up after a break. Architecture lives in
[`PLATFORM_BLUEPRINT.md`](./PLATFORM_BLUEPRINT.md); day-to-day commands live in
[`README.md`](./README.md). This file is only "where were we".

---

## Where things stand

| Area | State |
| :--- | :--- |
| **Phase 0 — Foundations** | ✅ Complete and verified end to end |
| **Multi-carrier logistics** | ✅ Framework complete; vendor HTTP transport deliberately not written |
| **Phase 1 — Catalog & Storefront** | 🟡 In progress — data model, domain logic and query layer done |

### Phase 1 progress

| Piece | State |
| :--- | :--- |
| Catalog schema + RLS + seed | ✅ 11 tables, policies auto-derived, demo catalog for both tenants |
| Catalog domain logic (`@platform/core/catalog`) | ✅ slugs, option matrices, money, search, category trees |
| Storefront query layer | ✅ listing, PDP, slug resolution, sitemap — integration tested |
| Storefront pages | ✅ home, category, collection, PDP, search — verified over HTTP |
| SEO surface (JSON-LD, sitemap, canonicals, redirects) | ✅ verified over HTTP |
| Media pipeline | ✅ Upload endpoint + worker job — validate, dedupe, AVIF/WebP/JPEG ladder |
| HTML sanitiser | ✅ Allowlist, applied on write; the PDP now renders rich descriptions |
| Console catalog CRUD | ✅ Products, variants, options, media attach, categories, collections, slug history |
| Bulk CSV import/export | ✅ One row per variant, dry-run by default, whole file in one transaction, export is the exact inverse |

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

**Open question for you:** a `trial` tenant is currently `noindex` in both
`robots.txt` and page metadata (the latter was already the Phase 0 behaviour).
Trial merchants launching a real store probably *do* want to be indexed. Worth
deciding before anyone onboards.

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
pnpm test:integration    # the 17-test isolation suite
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
| Version control | The project is **not** a git repository yet | Minutes |
| Storefront cache purge on catalog writes | `apps/storefront/src/lib/catalog.ts` tags every cached read and documents tag purges as "the primary invalidation path" — but nothing purges them, because until now nothing wrote. A merchant who edits a price waits up to the 300s TTL to see it. `revalidateTag` only clears the CALLING app's cache, so the console cannot do it directly: it needs either a shared cache handler or an internal purge endpoint on the storefront (the `/api/internal/verify-domain` shared-secret pattern already exists to copy). Verified live: the redirect and description below only appeared after the storefront was restarted | Half a day |
| Stock levels | The console can set a variant's SKU, price and low-stock threshold but not its quantity — there is no `stock_movements` table yet. The inventory ledger is Phase 2 (blueprint §4.5), and a mutable counter would be the wrong thing to add early | Phase 2 |

---

## Phase 1 scope, when resuming

Products, variants, options, categories, collections · bulk CSV import/export ·
media pipeline (upload → resize → AVIF/WebP → object storage → CDN) · storefront
home/category/PDP · Postgres FTS search · SEO: JSON-LD, meta management, sitemap,
canonicals, slug history with 301s.

**Exit criterion:** a full catalog live on a staging domain, passing Google's
Rich Results Test.
