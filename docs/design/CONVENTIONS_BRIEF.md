# Phase 2 Commerce Core — Conventions Brief

Every builder agent reads THIS FILE plus its own task, nothing else. It is
distilled from the repo's actual patterns (inventory ledger + reservations,
merged 2026-08-15) and from `PROJECT_STATUS.md`'s trap list. When your task
and this brief disagree, stop and flag it; do not improvise.

Repo: pnpm+turbo monorepo. `packages/core` (domain logic), `packages/db`
(schema + RLS + withTenant), `packages/integrations` (vendor adapters),
`apps/console` (merchant admin, Next 16), `apps/storefront` (buyer-facing,
Next 16), `apps/worker` (BullMQ).

---

## 1. Hard invariants

**Tenancy / RLS**
- Every query goes through `withTenant(tenantId, tx => …)` or
  `withPlatform(tx => …)` from `@platform/db`. The raw client is unexported
  and ESLint-blocked. There is no third door.
- `withTenant` sets `app.tenant_id` with `set_config(..., is_local => true)`
  — transaction-scoped. Never issue a session-level `SET` of tenant context.
- The **tenant id comes from the session (console) or the resolved host
  (storefront), never from a request payload**. No function signature may
  accept a tenantId that originated in a body.
- A new table is **tenant-scoped by default**: give it a `tenant_id uuid NOT
  NULL` column and the generated RLS policy (FORCE ROW LEVEL SECURITY +
  `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`)
  applies automatically via `packages/db/src/rls.ts`. To make a table
  control-plane (no RLS) you must add it to `PLATFORM_TABLES` in that file
  **with a written justification** — CI fails otherwise. Adding an entry
  there is a security decision. All Phase 2 commerce tables (carts, orders,
  order_lines, payments, invoices, invoice_series, promotions,
  coupon_redemptions, webhook_events, pincode data if tenant-owned) are
  tenant-scoped. FORCE RLS means: with no tenant context, reads AND writes
  match zero rows silently — a "no data" symptom is usually a missing
  `withTenant`, and an INSERT without the correct `tenant_id` is refused by
  the policy's WITH CHECK.
- **A foreign key does NOT enforce tenancy** (FK validation bypasses RLS).
  Every id a payload names must be verified with an explicit SELECT inside
  the same `withTenant` transaction before it is written (the
  `assertVisible` / `loadLineVariants` pattern). No exceptions.

**Money, ids, time**
- Money is `BIGINT` paise (`bigint` columns; `number`/`bigint` handled per
  existing `money.ts` helpers). Never float, never rupees, never strings.
  Carry an explicit `currency CHAR(3)` column ('INR').
- Primary keys are UUIDv7: `uuid("id").primaryKey().$defaultFn(uuidv7)`
  (`import { v7 as uuidv7 } from "uuid"`).
- Timestamps are `timestamp(..., { withTimezone: true })`, UTC in storage.
- Mutable tables carry `created_at`, `updated_at`, and actor columns where
  a staff member can touch them. History/ledger tables are append-only: no
  `updated_at`, no `deleted_at`, and append-only is enforced **by grant**
  (add the table to the `appendOnly` set in `rls.ts::grantStatements` —
  SELECT+INSERT only). Order events, payment webhook logs, invoice rows,
  and coupon redemptions belong in that set.
- History tables reference their subjects by **bare uuid, no FK** (the
  `stock_movements` / `audit_log` precedent): a RESTRICT FK breaks tenant
  cascade deletion, a CASCADE FK erases history. Ephemeral live-state
  tables (holds, carts) use real CASCADE FKs — state should die with its
  subject.

**Snapshots (blueprint line 365)**
- `order_lines` snapshot `title_snapshot`, `sku_snapshot`, `hsn_snapshot`,
  `unit_price_paise`, `tax_rate_bps`, `tax_paise` at purchase time. Nothing
  that renders or reprints an order/invoice may join to live catalog rows
  for these values. An order placed in March reprints in October with
  March's price, title, and tax rate.

**Invoice numbering (blueprint 367–393)**
- Numbers come from `invoice_series` via
  `UPDATE invoice_series SET next_number = next_number + 1 WHERE tenant_id
  = $1 AND series_code = $2 AND financial_year = $3 RETURNING next_number - 1`
  — **inside the same transaction as the order/payment confirmation**, so a
  rollback returns the number. Never `MAX(n)+1`, never an app counter,
  never a Postgres SEQUENCE (non-transactional, leaves gaps).
- Allocate at **payment confirmation**, never at cart or order creation.
  Abandoned carts must never consume numbers.

**GST engine**
- Pure functions: `(line, sellerState, placeOfSupply, registrationType,
  inclusive) → tax split`. Tax-inclusive is the default
  (`tax = price × r / (1 + r)`); support exclusive too.
- Intra-state → CGST r/2 + SGST r/2; inter-state → IGST at full rate.
  Place of supply = delivery address state.
- **Round PER LINE, HALF_UP, to paise; then sum.** Never sum-then-round.
- Apply discounts **before** tax computation. Shipping is a taxable line
  at the principal supply's rate, not an afterthought.
- Unregistered/composition tenants (`tenants.tax_registration_type`) get a
  Bill of Supply, never a Tax Invoice, and charge no GST.

**Payments (locked decisions — do not relitigate)**
- BYOG only: per-tenant gateway credentials, envelope-encrypted at rest
  (use the existing `packages/core/src/crypto` envelope machinery). Funds
  never touch the platform.
- Razorpay-shaped adapter interface in `packages/core`, implementations in
  `packages/integrations`, plus a **mock driver for dev/CI** — same pattern
  as the carrier registry, and like it the real-vs-fake gate must **fail
  closed** on unset NODE_ENV.
- **Webhooks are the source of truth, never the browser redirect.** Verify
  HMAC signatures, store the raw payload, process idempotently keyed on the
  gateway event id (unique constraint, not an app-side check).
- Partial payment: `cod_due_paise` is derived-and-synced state with an
  explicit `awb_cod_synced_at`; block edits after courier pickup.

**Order state machine**
- Explicit state enum + a transition table; illegal transitions throw a
  422 `AppError`. Each transition emits a domain event onto a queue —
  subscribers (messaging, analytics, inventory) are never called inline
  from the checkout handler.
- Order/RTO stock movements arrive as new members of
  `STOCK_MOVEMENT_REASONS` (migration extending the CHECK), written through
  `recordMovement`/`consumeStock` with `reference_type`/`reference_id` set.
  Ambiguous courier RTO text maps to `rto_initiated`, never `rto_delivered`.

**Promotions**
- Rules are data (`Condition[]` / `Effect[]` per blueprint §4.4);
  evaluation is a pure function `(cart, promotions, customer) →
  AppliedDiscount[]` — 100% branch coverage expected, no DB in those tests.
- Redemption limits are a `coupon_redemptions` table with a **unique
  constraint**, never an application-side counter.

**Reservations contract (already merged — reuse, do not rebuild)**
- `holdStock` / `releaseStock` / `consumeStock` / `getAvailability` /
  `recordMovement` in `@platform/core/inventory/server`. Checkout places a
  hold (reference `{type: 'checkout', id}` — 15-min TTL, replace
  semantics), releases it on abandon, and calls `consumeStock` inside
  payment-confirmation flow with the ORDER's lines (the order is the
  authority, never the hold rows).
- **Checkout must handle both failure codes**: `insufficient_stock` (stock
  genuinely gone) and `stock_held` (other references hold the remainder).
  `stock_held`'s current message is adjustment-shaped — reword it for the
  buyer path when you touch it.
- Hold expiry is **read-side**: every reader keeps the
  `expires_at > now()` filter. Never drop it "because the sweeper cleans
  up" — the GC is hygiene-only.

**Module hygiene**
- Extensionless relative imports repo-wide (Next cannot resolve ESM `.js`
  specifiers to `.ts`).
- Every new domain gets the barrel split: `@platform/core/<domain>` is
  PURE and client-safe (types, constants, pure functions — promotions
  evaluation, GST math, state-machine tables belong here);
  `@platform/core/<domain>/server` holds everything touching
  `@platform/db`. Register both in `packages/core/package.json#exports`.
  The pure barrel must not import `@platform/db` — the postgres driver's
  `fs`/`net` imports hard-fail a client build, which is the guard.
- Domain modules may not reach into each other's internals (ESLint rule);
  import from the module's public barrel.

---

## 2. The write-door recipe

Exemplar: `packages/core/src/inventory/server.ts` (`recordMovement`,
`holdStock`, `consumeStock`). Every commerce mutation (create order, apply
coupon, confirm payment, transition state) is a function in
`packages/core/src/<domain>/server.ts` shaped like this:

1. **Context in, not tenant-in-payload.** Take `WriteContext`
   (`{ tenantId, actorUserId, ip, userAgent, requestId }`) for staff
   actions, or a `ReservationContext`-style `{ tenantId, requestId }` for
   buyer actions with no staff actor. The route/session supplies it.
2. **Validate cheap invariants before opening a transaction** (integer
   ranges, non-empty lines, duplicate detection) and throw `AppError` with
   `code: "invalid_payload"`, status 422, and
   `details.issues: [{ path, message }]`.
3. **One `withTenant(ctx.tenantId, async (tx) => { … })` per entry point.**
   Everything that must be atomic happens inside it.
4. **Visibility SELECT before trusting any payload id** — variant ids,
   coupon ids, address ids, order ids. Select the row inside the tx; throw
   a typed 404 `AppError` if absent. FKs do not do this for you (§1).
5. **Idempotency**: client-supplied `idempotency_key` with a partial unique
   index `(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.
   Fast-path lookup first; catch the 23505 for the concurrent case and
   replay the winner. **Fingerprint the replay** — the key must match the
   full request or throw `idempotency_key_reuse` (422). Payment webhooks
   idempote on the gateway event id the same way.
6. **Same-transaction projection/counter writes.** If a table is a
   projection of a ledger (like `stock_levels`) or a counter (like
   `invoice_series`), it is written in the SAME transaction as the source
   row, by this one write door, never by a second writer. UPDATE-first,
   INSERT-if-no-row; let a CHECK constraint be the concurrency guard and
   map its violation (Postgres 23514) to a typed 422. Never "optimise"
   read-then-write around a CHECK.
7. **Lock ordering**: multi-row operations lock rows `FOR UPDATE` in
   **sorted id order** (see `lockLevels`) — the deadlock discipline.
8. **Audit inside the transaction**: `recordAudit(tx, tenantId, { actorType,
   actorUserId, action: "order.status_changed", entityType, entityId,
   before, after, ip, userAgent, requestId })`. Atomic with the change.
9. **Error mapping at the catch**: walk `err.cause` chains for the Postgres
   code (`pgError` helper), map known constraint names to typed `AppError`s
   (422 for domain refusals, 409 `concurrent_modification` for retryable
   races), rethrow the rest. Refusal error codes are part of the API
   contract — name them (`insufficient_stock`, `stock_held`,
   `coupon_exhausted`, `invalid_transition`, …) and keep them stable.
10. **Cache purge AFTER the commit, never inside it**, fail-soft:
    `await purgeStorefrontCache(tenantId, tags)` after `withTenant`
    resolves. A replayed idempotent call purges nothing (it wrote nothing).
11. **Queue/domain-event enqueue also after commit.** Nothing inline in the
    transaction may await an external system.

---

## 3. Console API route recipe

Exemplar: `apps/console/src/app/api/inventory/movements/route.ts` +
`apps/console/src/lib/catalog-routes.ts::handleCatalogWrite`.

- A route file contains: a zod payload schema and a thin
  `POST/PUT/DELETE` that calls `handleCatalogWrite(req, schema, (ctx,
  payload) => domainWrite(ctx, payload), { permission: "orders:write",
  successStatus: 201 })`. Despite its name the helper is not
  catalog-specific — pass your own `permission`. Do not hand-roll the
  pipeline; the helper fixes the order: authenticate (`getActorOrThrow`) →
  authorise (`assertCan`) → bounded body read (1 MiB) → JSON parse → zod
  parse → run with `WriteContext` → JSON response with `requestId`.
- Error envelope (already emitted by the helper /
  `errorResponse`): `{ error: { code, message, details? }, requestId }`.
  Validation failures are 422 with `details.issues: [{ path, message }]` —
  the SAME shape the domain layer's `AppError`s carry, so forms have one
  renderer. Never invent a new envelope.
- Path ids: run `rejectMalformedId(id)` before any query (malformed uuid →
  404, not a cast-error 500).
- New permissions go through `packages/core` permissions (`assertCan`,
  `Permission` type); pick `<area>:read` / `<area>:write` names.
- Storefront/buyer-facing endpoints (cart, checkout) have **no session
  actor**: resolve the tenant from the Host like the storefront does, use a
  buyer-shaped context, and still zod-parse + bound the body + return the
  same envelope. Webhook endpoints authenticate by HMAC signature instead
  of session — verify BEFORE reading the body into domain logic, store the
  raw payload, respond 2xx only after the idempotent write commits.

---

## 4. Storefront cache recipe

Exemplar: `apps/storefront/src/lib/catalog.ts` +
`packages/core/src/catalog/purge.ts` +
`apps/storefront/src/app/api/internal/revalidate/route.ts`.

- Every storefront route stays **force-dynamic** (full-route cache is
  keyed by pathname, NOT Host — static generation is a cross-tenant leak).
  Cache the database work only, with `unstable_cache(fn, ["kind",
  tenantId, …ids], { tags, revalidate: 300 })` — **tenantId in the key
  array AND in every tag**.
- Tags are defined ONCE in `packages/core` (the `catalogTags` pattern —
  put commerce tags beside it) and imported by both the reader
  (storefront) and the purger (console/domain writes). A purge tag that
  doesn't string-match a cache tag purges nothing, silently.
- Purging: domain writes call `purgeStorefrontCache(tenantId, tags)`
  **after commit** (it POSTs to the storefront's
  `/api/internal/revalidate` with the shared internal secret; it never
  throws — a failed purge must never fail the write; TTL is the backstop).
- Do not touch the revalidate route's `revalidateTag(tag, { expire: 0 })`
  call — `"max"` / named profiles / `updateTag` all break the purge on
  Next 16 (documented in the route). The endpoint refuses foreign-tenant
  tags as a set; keep new tags tenant-prefixed so that check holds.
- Live commerce reads (cart contents, availability at checkout) are NOT
  cached — `unstable_cache` is for catalog-shaped content. Availability
  shown on the PDP goes through the existing cached query + purge-on-write.

---

## 5. Worker job recipe

Exemplars: `apps/worker/src/jobs/sweep-reservations.ts`, `queues.ts`,
`index.ts`.

- **`import "./env"` must stay the FIRST import in
  `apps/worker/src/index.ts`** — ESM evaluates imports before the module
  body, and `queues.ts` reads `REDIS_URL` at module scope. Add new job
  imports BELOW it.
- Queue names + `defaultJobOptions` live in `@platform/core` (producers
  and the worker must agree without importing each other). Register the
  queue in `apps/worker/src/queues.ts`, the `Worker` in `index.ts`, and
  log `job.start` / `job.done` / `job.failed` as structured JSON with
  `tenantId` on every record.
- **Every job payload carries `tenantId`** (`TenantJob<T>`), and the
  handler's first act is `withTenant(job.data.tenantId, …)`. The single
  exception is the maintenance queue (platform-wide jobs, no tenantId),
  whose jobs fan out per tenant themselves: `withPlatform` for the tenant
  list, `withTenant` per tenant — a cross-tenant query on the app role
  silently matches zero rows.
- Every outbound vendor call (gateway verify, courier AWB) runs from a
  worker, never a web request: exponential backoff with jitter, capped
  retries, dead-letter visibility, circuit breaker per vendor, persisted
  redacted request/response logs per tenant (blueprint §5.4). Domain
  events from the order state machine are consumed here.
- Scheduled jobs use `queue.upsertJobScheduler(name, { every })` —
  idempotent across restarts.

---

## 6. Test recipes

**File naming & placement**
- Unit tests: `packages/core/tests/<topic>.test.ts` — pure logic, no DB,
  no env. GST math, promotion evaluation, state-machine transition tables
  belong here and should be exhaustive (discount/tax bugs cost money).
- Integration tests: `<pkg-or-app>/tests/<topic>.integration.test.ts`,
  run by `vitest.integration.config.ts` (loads root `.env`,
  `fileParallelism: false`, 30s timeouts). Console route tests live in
  `apps/console/tests`, storefront render/query tests in
  `apps/storefront/tests`, domain-vs-Postgres tests in
  `packages/core/tests`.

**Setup/teardown discipline (copy `stock-reservations.integration.test.ts`)**
- Suites create their OWN tenants/plans/users with an admin client
  (`postgres(DATABASE_URL_MIGRATOR)`), track every created id in Sets, and
  in `afterAll` **delete what they created, in order: tenants → users →
  plans** (tenant cascade first), then `await admin.end()` and
  `await closeConnections()`.
- Restore any `process.env` mutations BEFORE closing pools (the
  worker-suite lesson). Stub the purge endpoint with a local
  `node:http` server on port 0 when your write path purges.
- Seed stock through the real write door (`recordMovement`), not raw
  inserts, so `reconcileStockLevels` stays meaningful.
- Cache tests: assert visitor-visible values through
  `apps/storefront/tests/next-cache-harness.ts::runDynamicRender` (a bare
  cached call outside a work store recomputes stale entries and hides purge
  bugs), and put a real gap between a purge and the read that checks it
  (per-process clock skew makes same-instant asserts flaky).

**Execution rules**
- Builders run **unit tests only** (`corepack pnpm --filter <pkg> test`)
  plus typecheck/lint. **Integration runs are centrally coordinated** —
  they hit the one shared Docker Postgres and are serialized via turbo
  `dependsOn`; NEVER run integration suites concurrently against it, and
  never run `pnpm test:integration` from a builder task unless your task
  says so.
- **Count tracking**: `PROJECT_STATUS.md` pins exact test counts per
  package (currently 325 unit / 238 integration). When you add tests,
  report in your task result: file, how many tests added, and the new
  per-file count, so the coordinator can update the verified block. Never
  delete or skip an existing test to make a suite pass.
- Apps have a `tsconfig.json` / `tsconfig.test.json` split so tests stay
  out of `next build`'s typecheck; new test files go in `tests/**` (picked
  up automatically). App `typecheck` scripts run both projects.

---

## 7. Trap list — imperative

Tenancy & database
- Use `withTenant`/`withPlatform` for every query; never import the raw
  client. Take tenant id from session/host, never a payload.
- FORCE RLS on every new tenant table (automatic via `rls.ts`); justify
  any control-plane table in `PLATFORM_TABLES` in writing. Never derive
  RLS membership from "has tenant_id".
- Verify every payload id with a SELECT inside the transaction; never
  trust an FK to enforce tenancy.
- For cross-tenant maintenance, iterate tenants (`withPlatform` list,
  `withTenant` each); never run one cross-tenant query on the app role —
  it silently does nothing.
- Never put bind parameters in DDL; use `sql.raw(sqlLiteralList(...))`
  for CHECK lists.
- Never interpolate an outer column into a Drizzle SELECT-list correlated
  subquery (renders unqualified, silently matches the inner table); use
  JOIN + GROUP BY, or the written-out fragment pattern.
- Alias every raw SQL SELECT expression with `.as(...)` — un-aliased
  fragments collide as `?column?` and read null.
- Treat `tx.execute` rows as driver-level: convert timestamps/casing at
  the boundary; do not trust the type annotation.
- Never use `CREATE INDEX CONCURRENTLY` in a migration (single
  transaction). A data-repair migration on tenant tables must assert
  BYPASSRLS rather than trust it.
- In test fixtures holding a bare `postgres()` client, bind jsonb as
  `${...}::text::jsonb` — a bare `::jsonb` cast stores a jsonb STRING.
- History tables: bare-uuid references, no FK, append-only by absent
  grant. Live-state tables: CASCADE FKs, never RESTRICT.

Commerce correctness
- Allocate invoice numbers only via `UPDATE invoice_series … RETURNING`
  inside the confirming transaction, only at payment confirmation.
- Snapshot order lines; never join invoices/orders to live catalog rows.
- Round GST per line HALF_UP then sum; never sum-then-round. Apply
  discounts before tax. Default tax-inclusive.
- Trust webhooks, not redirects. Verify HMAC before work; idempote on the
  gateway event id via unique constraint.
- Enforce coupon limits with a unique constraint on `coupon_redemptions`,
  never a counter.
- Map ambiguous RTO text to `rto_initiated`, never `rto_delivered` —
  completing an RTO early restocks in-transit stock and oversells.
- Handle BOTH `insufficient_stock` and `stock_held` from `consumeStock`.
  Keep every reservation reader's `expires_at > now()` filter.
- Keep the `stock_levels` CHECK + same-transaction upsert as the oversell
  guard; never rewrite it as read-then-check-then-write.
- Never write a mutable counter as a source of truth; ledger + projection,
  reconcilable.

Next.js & caching
- Keep every storefront route force-dynamic; key all `unstable_cache`
  entries and tags by tenant id.
- Purge only after commit, fail-soft; never purge from inside a
  transaction.
- Keep `revalidateTag(tag, { expire: 0 })`; never a named `cacheLife`
  profile, never `"max"`, never `updateTag` in a route handler.
- Never import a `/server` barrel (or anything touching `@platform/db` or
  `sanitize-html`) from a client component; put client-needed constants in
  the pure barrel.
- Extensionless relative imports everywhere. Both Next apps load env via
  `dotenv-cli` at the repo root with `-v NODE_ENV=production` on
  build/start — keep that override; several gates fail open on unset
  NODE_ENV (mock gateway driver must follow the fake-carrier precedent:
  refuse in production, not "enable in dev").
- `permanentRedirect()` is a 308; express intent as `permanent: true`, not
  a status code.

Process & hygiene
- Keep `import "./env"` first in the worker entrypoint.
- Set `MEDIA_LOCAL_ROOT` absolute if ever set.
- Never write a raw NUL byte in source (write the six-character escape
  `\u0000` in the string literal instead) — git
  treats the file as binary and its diffs vanish.
- In CSV/import work: blank cell states nothing (never default a blank
  boolean to true); check caps on the MERGED entity, not the file;
  formula-escape `=`/`+`/`-`/`@` cells; test BOM handling against the
  reader, not parsed names; identify variants by id then SKU fallback.
- Set `publishedAt` on first activation (DESC sorts NULLs first).
- Test sluggability with `/[\p{L}\p{N}]/u` before calling `slugify` — it
  falls back to `"item"`, it does not fail.
- Ports are non-default on purpose (Postgres 5442, PgBouncer 6442, Redis
  6389). Do not "fix" them. `prepare: false` stays on the app pool
  (PgBouncer transaction pooling).

---

## 8. Commands

pnpm ships via Corepack only (`pnpm` is not on PATH in a plain shell):

```bash
corepack pnpm install                       # once per checkout
corepack pnpm --filter @platform/core typecheck
corepack pnpm --filter @platform/console typecheck   # runs both tsconfigs
corepack pnpm --filter @platform/core test           # unit tests (no DB)
corepack pnpm lint                          # eslint . at the repo root — the only lint
```

Nested scripts (`pnpm --filter` inside scripts) need the shim on PATH:
`corepack enable --install-directory <dir> pnpm`, then put `<dir>` on PATH.

Builders: run typecheck + lint + the unit tests of every package you
touched. Do NOT run `pnpm test:integration`, `pnpm build`, `db:migrate`,
or anything against Docker unless your task explicitly says so —
integration runs and migrations are centrally coordinated against the one
shared database. Migrations: add schema in `packages/db/src/schema/*.ts`,
then the coordinator runs `pnpm db:generate` + `pnpm db:migrate` (which
re-applies RLS idempotently).
