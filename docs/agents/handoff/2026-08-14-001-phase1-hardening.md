# Handoff — Phase 1 hardening wave

**Date:** 2026-08-14
**Session:** picked up the 2026-08-13 handoff and executed its follow-up list

---

## Goal

Execute the previous handoff's steps 2–4 plus the whole `docs/PHASE1_FOLLOWUPS.md`
"Fix soon" list, as one hardening wave: the client/server bundle boundary, the
integration-test leakage and lock contention, the `INTERNAL_API_SECRET` scoping
decision, and the eleven triaged importer/worker/storage defects.

The settings UI for `tenants.search_indexing`, deployment, and Phase 2 were
explicitly out of scope — the owner chose the hardening wave over those when
asked at session start.

---

## Current state

**The wave is complete and merged to `master`.** Working tree clean.

- `master` @ `eacb909`, with the wave merged as `8c98438` (a `--no-ff` merge of
  17 commits, plus a docs commit on top carrying the deferred-polish triage).
- Gate verified on the branch head and re-verified **on merged master**: lint
  clean, typecheck 6/6, build 2/2 (Next 16.3.0/Turbopack), **325 unit tests,
  185 integration tests** (was 321/174).
- Every task passed an independent spec+quality review; a final whole-branch
  review found two one-line gaps, both fixed and re-verified. Nothing is
  blocked. Still nothing deployed anywhere.

Both `phase1/completion` and `phase1/hardening` branches are kept as rollback
points until the platform runs somewhere real.

---

## What was accomplished

Eleven tasks, planned from four parallel investigation reports
(`docs/superpowers/plans/2026-08-13-phase1-hardening.md` is the committed plan),
executed subagent-driven with a review gate per task:

1. **`unescapeFormula` bijection** — import only strips apostrophes the
   exporter could have written; a Shopify `'90s Tee` / SKU `'0012` survives.
2. **Dry-run preview names what an update changes** —
   `ImportProductResult.changes` (`"description (cleared)"` style), rendered in
   the import panel. The blank-column-clears semantics were NOT changed — they
   turned out to be documented, deliberate behaviour; the preview's silence was
   the defect.
3. **Console numeric honesty** — `ProductForm`'s `parseInt` no longer truncates
   `"1.5"` weight/low-stock to `1`; the server's `z.int()` refuses it with a
   field-level 422 the form already renders.
4. **Over-cap escape hatches** — the console trim path (PUT with ≤cap variants
   on an over-cap product) is proven by test; both import rejection messages
   now state the workarounds.
5. **Worker media hardening** — a checksum-collision at the final UPDATE is
   adopted (row completes `ready` with NULL checksum) instead of stranding the
   row `failed` through five identical retries; `processing_error` now only
   ever holds curated merchant-readable sentences (raw errors go to the
   structured log; the storage-key leak is closed); the `MAX_IMAGE_PIXELS`
   docblock stopped lying about the 30M/50M split.
6. **Storage config hygiene** — blank `STORAGE_DRIVER` behaves as unset
   (local in dev, refuse in production); `.env.example` ships it blank;
   `packages/integrations` finally has a vitest config with `unstubEnvs`.
7. **PDP sanitise at cache fill** — the defence-in-depth pass moved inside
   `getCachedProduct`'s `unstable_cache` callback (per fill, not per request),
   and is now pinned by a test that writes hostile HTML straight to the column.
8. **`sanitize-html` behind the server barrel** — client-needed constants
   extracted to `catalog/description-policy.ts`; the pure barrel no longer
   evaluates sanitize-html at all; client chunks grep CLEAN. This restores the
   boundary guard Turbopack stopped enforcing — by construction, not by the
   `server-only` package (see Failed attempts).
9. **TLS-ask credential split** — dedicated `TLS_ASK_SECRET` carried in the
   Caddyfile ask URL's query string; `verify-domain` fails closed in
   production, relaxed in dev/test; five tests for a route that had zero.
10. **Integration suites clean up after themselves** — tenants→users→plans
    deletes in every suite, turbo `test:integration` serialized via
    `dependsOn: ["^test:integration"]` so the `ACCESS EXCLUSIVE` holder
    (packages/db) runs alone, worker env-var restore. Plus a one-off sweep of
    historically leaked rows (see Key decisions).
11. **Gate + docs reconciliation** — PROJECT_STATUS gained the wave's verified
    block with every count delta attributed; PHASE1_FOLLOWUPS' "Fix soon"
    items moved to a "Fixed in the hardening wave" section with commits.

---

## Files changed

36 files in the merge. Test suites and docs are summarised; this is the map of
where behaviour moved.

### Behaviour

| File | What it now does |
| :--- | :--- |
| `packages/core/src/catalog/csv.ts` | `unescapeFormula` strips only what `escapeFormula` produces; `ImportProductResult` carries `changes: string[]`. |
| `packages/core/src/catalog/bulk.ts` | `isChanged` became `changedFields` (same comparisons, labels out); over-cap messages state the escape hatches. |
| `packages/core/src/catalog/description-policy.ts` | New. The allowed-tags/schemes constants as pure data, importable by client components. |
| `packages/core/src/catalog/sanitize-html.ts` | Sanitiser only; constants re-exported from description-policy; no longer in the pure barrel. |
| `packages/core/src/catalog/index.ts` / `server.ts` | The barrel move: pure barrel exports description-policy; server barrel exports sanitize-html. |
| `packages/integrations/src/storage/index.ts` | Blank `STORAGE_DRIVER` = unset (`\|\|` not `??`). |
| `apps/worker/src/jobs/process-media.ts` | Collision adoption (`markReady(null)` on 23505 of the checksum index), `merchantFailureReason` curation, raw-error structured logging, no storage key in the column. |
| `apps/console/src/app/products/ProductForm.tsx` | `Number()` with blank→null for weight/low-stock; no client-side truncation. |
| `apps/console/src/app/products/import/ImportPanel.tsx` | Renders the per-product changes list in the preview. |
| `apps/console/src/app/api/internal/verify-domain/route.ts` | Auth = `?secret=` vs `TLS_ASK_SECRET`, constant-time, fail-closed in production, relaxed in dev/test. |
| `apps/storefront/src/lib/catalog.ts` | `getCachedProduct` sanitises descriptions at cache fill (imports the sanitiser from the server barrel). |
| `apps/storefront/src/app/[slug]/page.tsx` | Renders `product.description` directly with a pointer comment; no per-request sanitise. |
| `packages/core/src/media/validate.ts` | Docblock now tells the truth about the worker-vs-console pixel ceilings. |
| `infra/caddy/Caddyfile` | `ask ...?secret={$TLS_ASK_SECRET}`; comment marks the credential as dedicated. |
| `turbo.json` | `test:integration` has `dependsOn: ["^test:integration"]`; `TLS_ASK_SECRET` in globalEnv. |
| `.env.example` | `STORAGE_DRIVER=` blank; `INTERNAL_API_SECRET` comment corrected (purge only); `TLS_ASK_SECRET` added. |
| `packages/integrations/vitest.config.ts` | New. `unstubEnvs: true`, includes both `src/**` and `tests/**` test files. |

### Tests and docs

Every touched suite gained tracking arrays + a tenants→users→plans `afterAll`.
New suites: `apps/console/tests/verify-domain.integration.test.ts` (5 tests) and
`apps/storefront/tests/description-sanitise.integration.test.ts` (1 test, via the
work-store harness). `PROJECT_STATUS.md` has the wave's verified block and a
rewritten sanitize-html trap entry; `docs/PHASE1_FOLLOWUPS.md` has the fixed
list, a deferred-polish section, and the TLS-ask known-limitation rewrite.

---

## Files in flight

**Nothing.** Working tree clean, everything committed to `master`, no remote,
nothing deployed. The SDD workspace (`.superpowers/sdd/2026-08-13-phase1-hardening/`)
was deleted after the final review per process — its durable content (deferred
minors triage) was first committed into `docs/PHASE1_FOLLOWUPS.md`.

---

## Failed attempts and mistakes

**My errors:**

- **The plan shipped a guard test that could not fail.** Task 5's brief
  specified the decompression-bomb fixture and pattern assertions for the
  curated-error test — but the raw sharp message already satisfied all three
  patterns, so reverting the curation failed nothing. The final whole-branch
  review caught it; the fix (an exact-sentence assertion) was one line. The
  same session that wrote "six tests shipped that could not fail" into the
  previous handoff wrote a seventh into its own plan.
- **The plan's Task 10 file list was written before Task 7 existed** — so the
  new `description-sanitise` suite leaked its plan row, violating Task 10's own
  contract. Cross-task gap, caught only by the final review. Lesson recorded in
  FOLLOWUPS: leak verification must count `plans` and `users`, not just
  `tenants`.
- **The handoff's "two lines of `server-only`" premise was false**, and so were
  two items in the follow-ups doc as written: the `weightGrams` truncation was
  NOT in the CSV path (which already rejects fractional weights, with a test —
  it was in `ProductForm`), and "blank description wipes" was documented
  intended behaviour (the preview's silence was the real defect). All three
  were caught by the investigation pass before any code was written — which is
  the argument for investigating before planning.

**Environment failures that cost turns:**

- One reviewer died on a network error (`ENOTFOUND`) and, resumed, produced its
  review with zero new tool calls — the claims checked out against a manual
  spot-check, but reviews from resumed agents deserve that verification.
- Mid-session, dispatching on the sonnet model started failing with "not
  available on your foundry deployment" (it had worked for the first ~20
  dispatches). Later dispatches inherited the session model instead.
- The Task 10 implementer stopped mid-task while its integration run was in
  flight and had to be resumed with explicit finish-everything instructions.
- **`C:` hit 100% full** at session end and blocked the memory-file write; the
  owner cleared ~25 GB. Nothing was lost — the failed write left the original
  file intact.

**Rejected approaches (do not retry):**

- **`server-only` npm package for the boundary guard.** Its default export
  condition throws under plain Node: the worker reaches both guarded files
  through four import chains (including the root `@platform/core` barrel), all
  six vitest configs run under default conditions, and `ProductForm` (a client
  component) legitimately imports a constant that lived inside
  `sanitize-html.ts`. Any variant of this approach needs `react-server`
  resolution conditions everywhere plain Node runs — invasive and semantically
  wrong. The barrel move achieves the guard with zero dependencies.
- **Making `verify-domain`'s existing header check mandatory.** Caddy's
  `on_demand_tls { ask }` cannot send headers — the old fail-open branch was
  the only thing keeping TLS issuance alive. Enforcement had to move into the
  ask URL itself.

---

## Key decisions

| Decision | Why, and what was rejected |
| :--- | :--- |
| **Boundary guard by barrel restructuring**, not `server-only` | See above. Client-needed constants extracted to `description-policy.ts`; sanitize-html moved behind `catalog/server`, whose client-import hard-failure (postgres driver → `fs`/`net`) Turbopack still enforces. |
| **`TLS_ASK_SECRET` as a dedicated credential in the ask URL query string** | Caddy cannot send headers; a shared secret would 403 all issuance if enforced. Query-param transport is the only stock-Caddy option; fail-closed in production, relaxed in dev/test. A leaked ask URL decides nothing but TLS issuance. |
| **Blank weight → null → 422 stands** (owner-adjudicated) | A task reviewer wanted the schema nullable or client-side pre-validation. Overruled: weight is required by platform contract (the CSV path refuses blank weight for the same reason), and zod's refusal of null IS field-level. |
| **Checksum collision → adopt with NULL checksum** | NULLs are distinct under the unique index, so the row completes `ready` and simply never participates in dedupe. Rejected: failing the row (deterministic 5x retry failure with no repair path — the re-upload escape hatch dedupes onto the *other* row). |
| **Curated `processing_error`, raw to logs** | The column feeds the merchant's screen verbatim; the raw message (Postgres constraint text, storage keys) belongs in the structured log. |
| **turbo `dependsOn` for integration serialization** | Uses the real dependency graph: db (the `ACCESS EXCLUSIVE` holder) → core → apps concurrently. Rejected: `--concurrency=1` (slower than needed) and shrinking the lock window (the rewind must precede fixture seeding). |
| **The historical-leak sweep ran, prefix-scoped, SELECT-first** | Deleted 2,432 tenants + 2,538 plans accumulated over ~70 runs. `acme`/`globex` verified intact afterwards. ~95 `rc-`-prefixed tenants were deliberately NOT deleted — their origin is unidentified and unknowns stay. |
| **Kept both phase branches; committed the plan document** | Rollback points cost nothing until this runs somewhere real; the prior session's plan is tracked, so this one is too. |

---

## What a fresh agent would otherwise rediscover

- Everything in the previous handoff's list still holds: `pnpm` only via the
  `$HOME/.pnpm-shim` shims, ports 5442/6442/6389 and 3000-is-taken, the
  load-bearing `NODE_ENV=production` override, `withTenant` returning zero rows
  rather than erroring, the Drizzle silent-NULL traps.
- **`pnpm test:integration` is now serialized** (db → core → apps) and the
  suites clean up after themselves — two consecutive runs leave tenant, user,
  and plan counts unchanged. Full matrix wall time ~30–40 s.
- **`TLS_ASK_SECRET` must reach Caddy's process environment** or
  `{$TLS_ASK_SECRET}` substitutes empty and every ask 403s (fail-closed, but
  it looks like an outage). Nothing in `infra/` runs Caddy yet, so this bites
  exactly when the production manifest is first written — it's in the
  FOLLOWUPS deferred-polish list.
- **`tenants.search_indexing` still has no writer** — SQL-only until the
  settings UI exists.
- The dev DB holds ~95 `rc-`-prefixed mystery tenants and ~1,247 test-phone
  users (audit-referenced, pre-cleanup); harmless, sweep only with a SELECT
  first. `users` still has no real staff row — console login needs the README
  SQL after any volume reset.
- `docs/PHASE1_FOLLOWUPS.md` now has three sections that matter: fixed (with
  commits), deferred polish (triaged small stuff), and known limitations
  (deliberate). Read it before re-diagnosing anything on those lists.

---

## Next steps

1. **Build the settings UI that writes `tenants.search_indexing`** — the
   feature is inert without it; column, resolver, and tests all exist.
2. **Run this somewhere that is not this laptop.** No Dockerfile, no
   production compose, no remote. When writing the manifest: export
   `TLS_ASK_SECRET` to Caddy's environment (see above) and remember one purge
   reaches one storefront process.
3. **Phase 2 inventory** — `stock_movements` ledger is Phase 2's FIRST task
   (blueprint §4.5). No stock columns exist, deliberately; do not assume them.
4. The deferred-polish list in FOLLOWUPS is there when touching those files
   anyway — none of it is worth a dedicated session.

**Blocked on people, unchanged:** CA/lawyer sign-off on BYOG payments, TRAI
DLT registration, WhatsApp Business verification, Ekart partner agreement.
