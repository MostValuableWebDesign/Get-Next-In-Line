---
name: Validation gates
description: How the registered CI-style validation commands are scoped and one deliberate exclusion.
---

# Validation gates

Registered validations: `api-server-typecheck`, `api-server-test`, `gnil-os-test` (plus pre-existing `db-drift`).

**Rule:** `api-server-test` runs the full vitest suite with no exclusions.

**Why:** all suites now pass; excludes would hide regressions.

**How to apply:** if a suite goes permanently red again, fix the root cause (often DB drift — run `db:check-drift`) rather than re-adding excludes.
