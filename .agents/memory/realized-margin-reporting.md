---
name: Realized margin reporting
description: Profit/margin reporting must use per-assignment charged pricing, never inferred from current markup.
---

Rule: any profit/earnings reporting (e.g. agency dashboard) must derive from the realized per-charge pricing persisted on `tenant_modules` (`charged_wholesale`/`charged_resale`, cadence-specific amounts, bi-weekly ×26/12 monthly-equivalent).

**Why:** checkout supports `applyMarkup: false` (zero-margin provisioning) and the global markup% changes over time — inferring margin as `wholesale × current markup%` misreports profit. A completion review rejected exactly that inference.

**How to apply:** when adding new provisioning paths, always persist charged wholesale/resale on the assignment row; when reporting, fall back to inference only for legacy rows where both charged columns are NULL.
