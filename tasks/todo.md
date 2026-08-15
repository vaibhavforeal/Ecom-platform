# Phase 2 completion — commerce core (branch `phase2/commerce-core`)

Owner directive 2026-08-15 23:44: complete Phase 2 using multi-agent
orchestration. Exit criterion (blueprint §10): an order completes end to
end with a correct GST invoice — literal "real ₹1" needs the owner's
gateway keys; everything up to that ships with the mock driver.

Defaults locked (owner can override): Razorpay-shaped BYOG adapter +
mock driver first; tax-inclusive pricing default (§4.1); webhook-first
confirmation (§5.2); invoice numbering per §3.3 (allocate at payment
confirmation inside the order transaction).

## Waves

- [x] **A. Design** — DONE 01:01. Spec at `docs/design/PHASE2_COMMERCE_DESIGN.md`
      (1296 lines, 21 decisions); judges 2-1 for minimal-diff + grafts.
      Note: designers must WRITE files, not return blobs (stall detector).
- [x] **B. Schema spine (S0)** — DONE 01:40, committed. Migration 0008
      (15 tables) applied; checkpoint #1 green (existing 238 integration
      pass on new schema + inventory extract-method refactor).
- [ ] **C. Parallel build lots B1–B5** — IN PROGRESS (launched 01:45):
      B1 tax+invoices · B2 promotions · B3 payments · B4 cart+storefront
      · B5 orders+console. Disjoint file ownership; builders run unit
      tests only; integration checkpoint #2 (mine) after all report.
- [x] **D. B-INT integrator** — DONE 03:01; checkpoint #3 green after
      fixing the BullMQ colon-jobId defect (silent fail-soft enqueue
      failure invisible to all 353 passing tests — caught in stderr).
- [x] **E. Surfaces** — shipped inside lots B2–B5 + B-INT.
- [x] **F. Adversarial review** — DONE 03:47: 16 raised, 13 confirmed
      (1 critical: replay minted a second gateway order), 2 refuted,
      1 contested→deferred. Fixed by 2 parallel agents, all pinned.
- [x] **G. Gate + live pass** — DONE ~05:00: 533 unit / 365 integration /
      build 2/2; live COD order over HTTP (correct CGST/SGST, invoice
      0001), mock prepaid via signed webhook on dev-mode server (IGST,
      invoice 0002, fee economics), rate limit 429, gateway-less refusal
      clean. PROJECT_STATUS verified block written.

## Review notes

Phase 2 exit criterion: everything short of the literal real-₹1 order is
verified (that needs the owner's gateway keys — mock driver fails closed
in production by design). Deferred items in docs/PHASE2_FOLLOWUPS.md
"From the commerce-core wave". Orchestration lesson: agents composing
huge single responses trip the stall detector — have them write files
incrementally instead (cost one failed design wave).
