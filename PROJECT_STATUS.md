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
| Media pipeline | ⬜ Not started |
| Console catalog CRUD | ⬜ Not started — **blocks rich product descriptions**, see below |
| Bulk CSV import/export | ⬜ Not started |

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
- **`permanentRedirect()` emits 308, not 301.** Google treats them as
  equivalent, so this is fine — but the domain layer now returns
  `permanent: true` rather than claiming a status code it does not control.

---

## Open items

| Item | Why it matters | Lead time |
| :--- | :--- | :--- |
| CA + lawyer sign-off on BYOG payments | Decides the entire commercial structure of the SaaS phase | Start now |
| TRAI DLT registration (SMS) | Carriers silently drop unregistered traffic; blocks Phase 4 | Weeks |
| WhatsApp Business verification | Blocks Phase 4 messaging | Weeks |
| Ekart partner agreement | API docs and credentials are gated behind a Flipkart commercial agreement | Unknown |
| Version control | The project is **not** a git repository yet | Minutes |
| HTML sanitiser for product descriptions | The PDP currently renders `description` as **plain text**, deliberately: injecting merchant HTML would be stored XSS against that merchant's own customers on a page that will later collect addresses and payments. Needs an allowlist sanitiser applied on write, in the console — then the PDP can render rich copy | With console CRUD |

---

## Phase 1 scope, when resuming

Products, variants, options, categories, collections · bulk CSV import/export ·
media pipeline (upload → resize → AVIF/WebP → object storage → CDN) · storefront
home/category/PDP · Postgres FTS search · SEO: JSON-LD, meta management, sitemap,
canonicals, slug history with 301s.

**Exit criterion:** a full catalog live on a staging domain, passing Google's
Rich Results Test.
