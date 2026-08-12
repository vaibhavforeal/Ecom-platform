# Phase 1 follow-ups

Triaged at the end of the `phase1/completion` branch by two independent
whole-branch reviews. Nothing here blocks the merge — the merge blockers were
fixed on the branch. This is the carried-forward list, in priority order, so it
does not live only in a reviewer's head.

Each item was found during the branch and deliberately deferred rather than
missed.

---

## Fix soon

| Item | Why it matters |
| :--- | :--- |
| **Restore a real client/server boundary guard** | Under Next 15 + webpack, a client component importing `@platform/core/catalog` (which re-exports `sanitize-html`) was a **build error**. Under 16 + Turbopack it builds silently and ships ~190 KB of dead client weight. `@platform/core/catalog/server` still hard-fails, so the driver/filesystem/native boundary is intact — but the cheap fix is the `server-only` package at the top of `catalog/server.ts` and `sanitize-html.ts`, which makes it a build error by construction again. A CI grep of `.next/static/chunks` against a denylist is the alternative. An ESLint `no-restricted-imports` rule will **not** work — it cannot see through the barrel. |
| **Integration-test leakage and lock contention** | Six suites close pools in `afterAll` but issue no `DELETE`, leaking ~35 tenants, ~50 products and ~15 `media` rows per run. Separately, `media-dedupe-migration.test.ts` takes `ACCESS EXCLUSIVE` on `media` for a whole transaction and replays migration 0004's whole-table scan. `turbo.json`'s `test:integration` has no `dependsOn`, so five packages run concurrently against one Postgres. These are one problem compounding: every leaked row lengthens the window in which the lock blocks everything else. An ABBA deadlock is reachable in principle. Four suites already clean up properly and are the model. |
| **`unescapeFormula` strips a leading apostrophe from every import** | A Shopify export whose title is `'90s Tee` imports as `90s Tee`. Silent one-character mutation, on the migration path, which is the importer's entire purpose. |
| **Dry-run preview does not show *what* an update changes** | A CSV with a blank `description` column previews as "1 to update" and then wipes the description. The preview is the merchant's only defence before committing. |
| **`validate.ts` docblock overstates `MAX_IMAGE_PIXELS`** | It still claims to be the ceiling for every `sharp()` call; the 30 M request-path / 50 M worker split made that untrue. Same disease as the trap-note corrections below, but on a security control. |
| **Worker checksum backfill can 23505 into a permanently-failed row** | And `ProductForm` renders `processing_error` verbatim, so a raw Postgres constraint string can reach the merchant. |
| **`.env.example` pre-fills `STORAGE_DRIVER=local`** | Copying the template into production satisfies the fail-closed gate without a decision being made, and uploads silently land on container disk. A blank value fails closed. |
| **`Number.parseInt` on `weightGrams` truncates `"1.5"` to `1`** | Silent, on the field every Phase 3 courier rate will be computed from. |
| **PDP re-sanitises up to 60 kB on every request** | Under `force-dynamic`, against a 2.5 s LCP budget, when the column is already sanitised on write. The pass is deliberate defence-in-depth (the seed script writes HTML directly, bypassing the write layer) — but it is per-request. |
| **An over-cap legacy product rejects the whole CSV file** | And the console repair path 422s too, so there is no escape hatch. Correct per the rules; first place they produce a hard refusal. |
| **`packages/integrations` has no vitest config** | So `unstubEnvs` is false and `vi.stubEnv` leaks across a file; one test already re-stubs four vars to undo an earlier leak. |

## Known limitations, by design

- **A purge reaches one storefront process.** Multiple replicas need load-balancer
  fan-out. Not a defect; the endpoint is correct for a single process.
- **`tenants.search_indexing` has no writer.** Task 1 built the column, the
  three-mode resolver and the truth-table tests, but nothing in the repo sets it —
  no route, no console screen. It is SQL-only until a UI exists.
- **Per-variant stock is unbuildable.** No quantity column and no
  `stock_movements`; the inventory ledger is Phase 2.
- **No CSP, CSRF rests on `SameSite=Lax`, no rate limit on catalog writes or
  uploads.** All three were reviewed and deliberately deferred.
- **`pending`/`failed` media renders a placeholder, not the original.** Accepted:
  a `pending` row has NULL dimensions, so rendering it would guarantee a wrong
  aspect ratio and a layout shift on every non-square image.
- **`INTERNAL_API_SECRET` now guards two capabilities** — Caddy's on-demand TLS
  `ask` and the cache purge. The purge fails closed; `verify-domain` skips its
  check when the secret is unset. Worth scoping or rotating separately.

## Process notes worth keeping

Three separate **wrong mechanisms** were written into `PROJECT_STATUS.md` during
this branch and later corrected — each a mechanism inferred from observed
behaviour and recorded as fact without probing it. All three probes took seconds.
The trap list is treated as authoritative by everyone who reads it, so a wrong
entry there is worse than no entry.

Six tests were shipped during this branch that **could not fail**: a fixture
sized from the constant under test, a vacuous assertion, a `toContain` satisfied
by an input echo, a header assertion built from the constant it tested, a limit
assertion its own fixture could not violate, and a test whose harness diverged
from production on the property under test. All six were caught by review and
fixed. Hard-code expected values; assert behaviour, not mechanism.
