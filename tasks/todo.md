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
- [ ] **D. Checkout orchestration** (serial core): cart server module →
      checkout-start (holdStock + pending_payment order) → payment
      adapter contract + mock + razorpay drivers → webhook route (HMAC,
      idempotent on gateway event id) → consumeStock + invoice
      allocation on confirm → order state machine + domain events →
      abandoned-cart TTL job (release holds).
- [ ] **E. Surfaces** (parallel): storefront cart/checkout/order-status
      pages + APIs · console orders list/detail + transitions + settings
      for gateway credentials (envelope-encrypted) · invoice render.
- [ ] **F. Review** (workflow): multi-dimension find → adversarial
      verify → fix wave. Repo traps are review dimensions.
- [ ] **G. Gate + live pass** (inline, serial): full gate; live pass on
      production builds incl. mock-gateway ₹1 order; PROJECT_STATUS
      verified block; PR.

## Review notes

(fill as waves complete)
