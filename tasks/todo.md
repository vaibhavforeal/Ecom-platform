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

- [ ] **A. Design** (workflow): conventions brief from PROJECT_STATUS
      traps + existing code patterns; 3-way independent schema/flow
      design panel → judged → synthesized into
      `docs/design/PHASE2_COMMERCE_DESIGN.md`. I review before build.
- [ ] **B. Schema** (single agent, serial — gates everything): migration
      0008 — customers/addresses, carts+lines, orders+lines, payments,
      invoice_series+invoices, promotions+coupon_redemptions,
      serviceability; enums; PLATFORM_TABLES classification; isolation
      test expansion. Gate: db integration suite green.
- [ ] **C. Pure domain** (parallel agents, disjoint files, unit-TDD):
      GST engine (100% branch) · promotions evaluation (pure fn) ·
      partial-payment math · invoice number allocator · serviceability
      check. Integration suites run centrally between waves, never by
      builders (shared DB).
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
