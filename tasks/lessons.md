# Lessons

- **2026-08-14 (containerized-deployment wave):** A runbook written from
  recollection fabricates. Task 6's writer reconstructed the seed/staff-SQL
  step instead of copying it from the executed transcript sitting in the
  same workspace — wrong command, wrong columns, a hardcoded token — and
  the per-task reviewer missed it because the prose read plausibly. Rule:
  every command that lands in a runbook is copied from a transcript of its
  actual execution, or re-executed before writing; reviewers diff runbook
  SQL/commands against the schema and the evidence report, not against
  plausibility.
- **2026-08-14 (same wave):** A generated-secrets file needs its
  .dockerignore entry the moment the generator is designed, not when
  someone notices the image carries passwords. Plans that add generated
  files in a later task must update ignore files owned by an earlier task
  in the same breath.
- **2026-08-15 (inventory-ledger wave):** The runbook-fabrication lesson
  recurred in a new form: PROJECT_STATUS's verified block had correct
  COUNTS but attribution prose citing nonexistent test files — written
  from the plan's expectations, not the tree. What caught it was a
  reviewer explicitly instructed to diff doc claims against the evidence
  report claim-by-claim. Rule: any doc reviewer for a verified block gets
  that instruction verbatim; counts alone passing is not enough.
- **2026-08-15 (same wave):** Plans that inline complete code ship
  plan-authored bugs — the planned single upsert was defective (Postgres
  evaluates CHECK on the candidate INSERT tuple BEFORE conflict
  arbitration, so negative deltas failed even when the updated value was
  legal), and the planned idempotency replay lacked a request fingerprint.
  Both were caught by implementer deviation reports and named-risk review
  dispatches. Rule: treat implementer deviations as signal, never noise —
  and when a review flags a risk in planned code, the plan does not grade
  its own work.
