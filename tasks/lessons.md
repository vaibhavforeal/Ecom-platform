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
