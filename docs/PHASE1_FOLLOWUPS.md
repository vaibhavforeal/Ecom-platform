# Phase 1 follow-ups

Triaged at the end of the `phase1/completion` branch by two independent
whole-branch reviews. Nothing here blocks the merge — the merge blockers were
fixed on the branch. This is the carried-forward list, in priority order, so it
does not live only in a reviewer's head.

Each item was found during the branch and deliberately deferred rather than
missed.

---

## Fixed in the hardening wave (2026-08-13, branch `phase1/hardening`)

Every "Fix soon" item carried out of the completion branch was fixed on this
branch. One line each, naming the fixing commit:

- **Client/server boundary guard** — `b624681`: `sanitize-html` moved behind
  `@platform/core/catalog/server`, whose postgres-driver import still hard-fails a
  client build; the two policy constants moved to `description-policy.ts` on the
  pure barrel. `server-only` was investigated and rejected — it would crash the
  plain-Node worker and every vitest suite.
- **Integration-test leakage and lock contention** — `6813513`: every suite deletes
  what it creates (tenants → users → plans), and `turbo.json`'s `test:integration`
  gained `dependsOn: ["^test:integration"]`, so db's `ACCESS EXCLUSIVE`-holding
  suite runs alone before everything else. `1bc9fb9` restores worker env vars
  before the pool closes.
- **`unescapeFormula` strips a leading apostrophe from every import** — `8cb7841`:
  it now strips only what `escapeFormula` could have added (a guard before a
  formula lead or another apostrophe); `'90s Tee` passes through untouched.
- **Dry-run preview does not show what an update changes** — `bda566a`: the preview
  names each changed field and flags clears (`1d585ea` hoists a redundant
  sanitiser call).
- **`validate.ts` docblock overstates `MAX_IMAGE_PIXELS`** — `5346d0e`: the
  docblock now states the 30 M request-path / 50 M worker split.
- **Worker checksum backfill can 23505 into a permanently-failed row** — `5346d0e`:
  a collision is adopted instead of stranding the row, and `processing_error`
  carries a curated message, never a raw constraint string (`2e08d85` restored the
  spec's three explicit assertions on it).
- **`.env.example` pre-fills `STORAGE_DRIVER=local`** — `b5bedca`: the template now
  ships the var blank, and a blank value fails closed.
- **`Number.parseInt` on `weightGrams` truncates `"1.5"` to `1`** — `7760751`:
  `Number(...)` instead, pinned by a fractional-weight test.
- **PDP re-sanitises up to 60 kB on every request** — `0b94be5`: sanitised once at
  cache fill in `getCachedProduct`, so every render of the entry pays nothing.
  `generateMetadata` still passes descriptions through the plain-text stripper
  rather than the sanitiser — deliberate; no markup survives `plainText`.
- **An over-cap legacy product rejects the whole CSV file** — `a196b99`: the
  rejection message now names both escape hatches (drop the product's rows, or
  trim it in the console first), and the console trim path is pinned by a test.
- **`packages/integrations` has no vitest config** — `b5bedca`: config added with
  `unstubEnvs: true`; stubs no longer leak across files.

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
- **TLS ask secret is query-string-only.** `TLS_ASK_SECRET` rides the Caddyfile's
  ask URL (`?secret={$TLS_ASK_SECRET}`) because Caddy's `on_demand_tls { ask }`
  directive cannot send headers. Dedicated credential, not shared with the purge.

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
