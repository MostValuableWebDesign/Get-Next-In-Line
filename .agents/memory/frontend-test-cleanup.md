---
name: Frontend test auto-cleanup
description: RTL cleanup pitfall when vitest globals are disabled
---

Frontend tests use vitest + jsdom + React Testing Library per artifact.

**Why:** With `globals: false` in vitest config, RTL's automatic cleanup does not run, so rendered components leak across tests and cause cross-test failures.

**How to apply:** the test setup file must explicitly call `afterEach(cleanup)` from `@testing-library/react`.
