# Handoff — Phase 2 completed overnight: the commerce core

**Date:** 2026-08-16
**Session:** resumed the stock-reservations branch, put the repo on GitHub
(PR #1), then executed the owner's directive "complete phase 2 today using
it" — a full multi-agent overnight build of the commerce core (PR #2),
both PRs merged to `master` on the owner's word

---

## Goal

Two goals, sequentially. First: finish `phase2/stock-reservations` (re-run
the gate on the post-review-fix tree, integrate). Second, from the owner at
23:44: **complete all of blueprint Phase 2 tonight using multi-agent
orchestration** — cart, checkout, serviceability, BYOG payments, order
state machine + events, GST engine + invoicing, promotions. Exit criterion
(§10): an order completes end to end with a correct GST invoice; the
literal "real ₹1" was known upfront to need the owner's gateway keys.

---

## Current state

**Both waves merged to `master` and green everywhere.** Working tree clean,
nothing deployed to a real host.

- `master` @ `c3525ff` (merge of PR #2, 15 commits), on top of `e956742`
  (merge of PR #1, stock reservations). Feature branches deleted;
  `phase1/*` + `infra/dry-run` kept as rollback points.
- **The repo is now on GitHub: `github.com/vaibhavforeal/Ecom-platform`,
  PUBLIC** — owner's explicit choice, including the DotPe/Bill Pepp
  reference doc in history (warned, accepted). CI works and is verified on
  both triggers (pull_request + push to master).
- Gate at merge: lint clean, typecheck 6/6, build 2/2, **533 unit
  (core 478, integrations 46, console 9), 365 integration (db 33, core
  128, worker 20, storefront 40, console 144)** — was 332/238 at the
  directive. Confirmed three ways: local, live HTTP pass, GitHub CI.
- Migrations at **0008**. Dev DB: acme is GST-regular (origin `07`, test
  GSTIN), MUG/SCARF stocked, two live-pass orders (1001 COD, 1003 prepaid)
  and invoices INV/2026-27/0001+0002 exist.
- Remaining Phase 2 stub: CSV bulk opening balances (own design pass).
  The real-₹1 order is blocked on the owner (gateway keys + domain).

---

## What was accomplished

**Wave 0 — reservations closed out (23:00–23:40).** Post-review-fix gate
re-run fresh (`turbo run test:integration --force`, 238 green), GitHub
remote wired (owner authed the `workflow` scope via device flow), both
branches pushed, PR #1 opened, CI's first-ever run fixed (see failures),
merged on the owner's "merge".

**Waves A–G — the commerce core (23:44–05:00),** orchestrated as: design
panel workflow → serial schema spine → 5 parallel builder lots → serial
integrator → adversarial review workflow → 2 parallel fix agents → gate →
live pass. ~50 agents, ~6M subagent tokens.

- **Design** (`docs/design/PHASE2_COMMERCE_DESIGN.md`, 1296 lines): 3
  independent designs (correctness / minimal-diff / operator-UX), 3
  judges voted 2–1 minimal-diff, synthesizer grafted the losers' best
  ideas; 21 contested points resolved in a Decisions table (D1a–D21).
  `docs/design/CONVENTIONS_BRIEF.md` (450 lines) distills the repo rules
  every builder followed.
- **Schema** (migration 0008): 15 tenant-scoped tables in
  `commerce.ts`/`payments.ts`/`promotions.ts`; history tables append-only
  by grant, FK-less subjects; PLATFORM_TABLES untouched; frozen stub
  signatures for every cross-lot contract; `consumeStockWithin`/
  `restockWithin` extracted from inventory with the public API unchanged.
- **Domain + surfaces** (lots B1–B5, disjoint files, zero conflicts):
  GST engine (inclusive extraction, per-line HALF_UP, D18 sum-invariant
  split, IST FY), gap-free invoice allocator (UPDATE..RETURNING in the
  confirming tx), promotions (pure evaluator, constraint-backed slots),
  payments (mock+razorpay adapters, dual sealed blobs with distinct AADs,
  raw-body HMAC), carts/serviceability/customers + storefront pages,
  orders state machine (single `transitionOrder` writer + D21 belt) +
  console orders/promotions/payments/customers + print-CSS invoice.
- **Checkout integrator** (B-INT): `startCheckout` (idempotency D1a,
  pincode-state cross-check D3, holds, snapshot lines, synchronous gateway
  D4), ONE confirm door for COD (D5) and webhooks (evidence-row TX first,
  2xx only after commit), D2a shortfall/`stock_held` cancel+refund, D9
  late-capture auto-refund, expiry via delayed job + 10-min sweep (D10),
  worker jobs, console nav.
- **Adversarial review**: 6 finder dimensions over the branch diff, 2
  refuters per finding voting to kill. 16 raised → 13 confirmed → all
  fixed and pinned (details in `docs/design/REVIEW_FINDINGS.json`).
  Headliners: a **critical** replay race minting two live gateway orders
  (fixed: reuse stored ref under the order lock, first-writer-wins);
  Razorpay's `fee` already includes GST (console net-settlement was
  double-subtracting); GST-regular tenant with NULL origin state silently
  taxed everything IGST (now refuses `seller_state_unconfigured`);
  non-idempotent gateway refunds (now claim-first, retry never re-calls);
  unthrottled anonymous checkout (now 5/min per tenant+ip).
- **Live pass**: production storefront — COD order over HTTP with
  hand-verified CGST/SGST and invoice 0001, guest-token gate, idempotent
  replay, 429 on the 6th checkout, clean gateway-less refusal; dev-mode
  server (mock driver fails closed in production BY DESIGN) — signed
  `payment.captured` webhook → confirmed paid order, inter-state IGST,
  invoice 0002 sequential while ORDER numbers legitimately gapped, fee
  economics persisted, evidence row stored.

---

## Files changed

The wave touched ~120 files (see PR #2 / merge `c3525ff` for the diff).
Map of the entry points a reader actually needs:

| File | What it now does |
| :--- | :--- |
| `docs/design/PHASE2_COMMERCE_DESIGN.md` | The build spec: schema, flows, D1a–D21 decisions, test matrix. Read §0 before touching anything commerce |
| `docs/design/CONVENTIONS_BRIEF.md` | Repo rulebook distilled for builders (write-door recipe, trap list) — the best onboarding doc in the repo now |
| `docs/design/REVIEW_FINDINGS.json` | All 13 confirmed review findings with refuter reasoning |
| `docs/PHASE2_FOLLOWUPS.md` | "From the commerce-core wave" — every deferral and known limitation, triaged |
| `packages/db/src/schema/{commerce,payments,promotions}.ts` | The 15 new tables |
| `packages/db/drizzle/0008_glorious_sally_floyd.sql` | The migration (applied to dev) |
| `packages/core/src/checkout/server.ts` | The spine: startCheckout, both confirm paths, expiry, cancel — most review findings landed here |
| `packages/core/src/{tax,invoices,promotions,payments,orders,cart,serviceability,customers}/` | One module per domain, pure vs `/server` split per convention |
| `packages/integrations/src/payments/` | Adapter contract, mock driver (+webhook signer), razorpay driver, fail-closed registry |
| `apps/storefront/src/app/api/{cart,checkout,payments/webhook}/` | Buyer API; webhook route resolves tenants WITHOUT the buyer-status filter (evidence-first) |
| `apps/storefront/src/app/{cart,checkout,order/[id]}/` | Buyer pages; order page is guest-token-gated |
| `apps/console/src/app/{orders,promotions,customers,settings/payments}/` | Merchant surfaces; orders detail renders net settlement = amount − fee |
| `apps/worker/src/jobs/{order-events,gateway-refund,sweep-checkouts}.ts` | Event fan-out, claim-first refunds, expiry backstop sweep |
| `PROJECT_STATUS.md` | Verified blocks for both waves (2026-08-15 reservations re-run + 2026-08-16 commerce core) |

---

## Files in flight

None. Working tree clean on `master`, everything pushed. Dev Docker infra
(postgres/redis/pgbouncer, ports 5442/6442/6389) left RUNNING. No
production servers running (live-pass servers on 3010/3011 were killed by
port PID). Docker Desktop was started by this session.

---

## Failed attempts

- **Design workflow stalled 6×/agent (~35 min lost):** designers forced to
  return complete designs as one giant structured output produce minutes
  of tokens with zero tool calls — the harness stall detector kills them.
  Fix that worked: agents **write deliverables to files incrementally**
  and return a 10-line summary. Applies to any large-output agent.
- **`pnpm test:integration -- --force` is a trap:** pnpm's `--` forwards
  the flag through turbo into vitest, which rejects `--force` and exits 1
  with no test output. Use `npx turbo run test:integration --force`.
- **Live-pass DB seed silently no-oped twice:** (1) `docker exec` without
  `-i` feeds a heredoc nothing — psql runs zero statements, exit 0;
  (2) a wrong `ON CONFLICT` target aborted the single `-c` transaction so
  even the earlier statements rolled back; (3) the seed used an all-zeros
  `location_id` but the app get-or-creates a per-tenant default location —
  seed at the REAL location id (query `locations` first).
- **Running a one-off TS script against workspace packages:** `/tmp`
  scripts fail (CJS top-level-await, then module resolution outside the
  repo). What worked: put the `.mts` INSIDE a workspace package and run
  `node node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/cli.mjs` from
  there, with `.env` sourced via `set -a; . ./.env; set +a`.
- **curl vs production cookies:** cookies are keyed to the CONNECTION
  host (Host-header tricks lose them), and the cart cookie is `Secure` so
  plain-http curl won't replay it — force `-H "Cookie: cart_id=..."`.
- **First-ever CI run failed twice by config:** `pnpm/action-setup@v4`
  refuses when the workflow pins a version AND `packageManager` exists
  (removed the workflow pin); the push trigger said `main` but the default
  branch is `master` (CI would never have run on merges).
- **My own briefing error, caught by the builder:** told B2 that a
  redemption-slot 23505 maps to `{claimed:false}`; the spec says a slot
  race is a retryable 409 (exhaustion comes from the count). The agent
  followed the spec and flagged the conflict — the "stop and flag, don't
  improvise" instruction earns its keep.
- **BullMQ silently rejected every expiry/refund enqueue** (`:` forbidden
  in custom job ids) while all 353 integration tests passed — the
  enqueues are fail-soft by design, so nothing red appeared. Caught only
  by reading stderr during the central run. Fix + a real-queue assertion
  so it can't regress silently.

---

## Key decisions

- **Repo public including the DotPe doc** — owner's explicit decision
  after being warned (it's in full git history; removing it would need a
  history rewrite). Do not re-raise; do re-check before pushing NEW
  sensitive material.
- **Merge commits, not squash**, matching phase precedent; branches
  deleted after merge.
- **The design's own decisions live in the spec** (D1a–D21) — the ones a
  future session will most likely want to re-litigate: COD confirms at
  placement through the same door (D5, invoice-timing rationale
  preserved); `abandoned` is terminal, late captures auto-refund (D9);
  fire-and-forget events with `jobId = order_events.id`, outbox sweep
  deferred (D11); no shipping-zones table yet (D13).
- **Mock gateway fails closed in production** (fake-carrier precedent) —
  consciously accepted that the production live pass covers COD only and
  the prepaid path is verified on a dev-mode server + 365 tests.
- **Review-fix directions chosen by the coordinator** (not the finders):
  net settlement = amount − fee (Razorpay semantics); claim-first refunds
  that park a crashed call as `needs_reconciliation` rather than risk a
  double refund; NULL-origin-state refuses checkout rather than guessing;
  order numbers MAY gap (only invoice numbers are gap-free by law) — the
  `payments_not_configured` probe consuming 1002 is correct behavior.
- **Rejected:** building a shared UI package tonight just to share
  `InvoiceDocument` with the storefront guest page (reference render kept
  instead); fixing the contested carrier-mode serviceability finding
  (nothing real to consult until Phase 3 carriers).

---

## What a fresh agent would otherwise rediscover

- **GitHub:** `gh` is authed as `vaibhavforeal` WITH the `workflow` scope.
  CI pins pnpm only via `packageManager` — do not add a version to
  `pnpm/action-setup`.
- **pnpm:** not on PATH; shims live at `~/.corepack-shims` — export
  `PATH="$HOME/.corepack-shims:$PATH"` per shell (state doesn't persist).
- **Turbo caches aggressively** — a "passing" run may be a cache hit;
  `--force` for fresh evidence.
- **Dev DB state (intentional):** acme = GST-regular, origin `07`, GSTIN
  `07AABCA1234A1Z5`; owner user "Live Pass Staff" (+919899299999); a mock
  payment account (webhook secret `whsec_live_pass_0001`, fingerprint-only
  in reads); stock MUG=2/SCARF=5; orders 1001/1003 + invoices 0001/0002.
  95 stale `rc-`/`pr-` tenants + 1,246 orphan users from pre-08-13 suites
  were purged.
- **`docs/design/` is the fastest onboarding path** for anything commerce:
  brief → spec §0 → FOLLOWUPS.
- The `.remember` plugin's haiku extraction was failing at session start
  (OAuth expired) — session summaries may be thin for 2026-08-15 late.

---

## Next steps

1. **CSV bulk opening balances** — the last Phase 2 stub. Needs its own
   design pass first (absolute-quantity-to-delta against the append-only
   ledger; dry-run preview; idempotency) — see PHASE2_FOLLOWUPS.
2. **CA questions** (owner, can start immediately): shipping GST
   principal-supply proxy, BYOG/TCS sign-off — both flagged in
   FOLLOWUPS/spec open questions.
3. **Real ₹1 order** (owner-blocked): needs a VPS + domain + the owner's
   gateway keys entered in console Settings → Payments; the whole flow up
   to the gateway hand-off is verified. The checkout page's real Razorpay
   browser-script invocation is a small remaining wiring task when keys
   exist (mock has no browser flow — B-INT left the hand-off shell).
4. **Phase 3 — carriers**: wire the first two carrier HTTP transports into
   the existing framework; that also unblocks the carrier-mode
   serviceability stub, credit notes (with RTO), and COD reconciliation.
5. **Small cleanups when next touching the area** (FOLLOWUPS): move the
   refund claim/record writes into `payments/server` as write-door
   functions; consider moving rate-limit constants beside
   `OTP_RATE_LIMITS`; Phase 4 outbox repair sweep.
