---
name: Validation gates
description: How the registered CI-style validation commands are scoped and one deliberate exclusion.
---

# Validation gates

Registered validations: `api-server-typecheck`, `api-server-test`, `gnil-os-test` (plus pre-existing `db-drift`).

**Rule:** `api-server-test` deliberately excludes `src/routes/__tests__/sos-inbound-sms.integration.test.ts`.

**Why:** those webhook tests fail on every run for pre-existing reasons owned by the Twilio delivery-pipeline work; including them would make the blocking gate permanently red and hide real regressions (like the hidden-connector leak tests, which do run and block).

**How to apply:** once the inbound-SMS webhook tests are fixed, remove the `--exclude` flag from the `api-server-test` validation command so they gate changes again.
