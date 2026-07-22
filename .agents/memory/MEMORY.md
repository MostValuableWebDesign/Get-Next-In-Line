# Memory index

- [Testing admin APIs with curl](api-testing-auth.md) — session cookie is Secure; authenticate over https://$REPLIT_DEV_DOMAIN, not localhost:80.
- Frontend tests use vitest+jsdom+RTL per artifact; with `globals: false`, RTL auto-cleanup is off — setup file must `afterEach(cleanup)` or renders leak across tests.
- Drizzle `push` can prompt interactively (unique constraints) and fail in non-TTY shells; applying additive DDL via executeSql on the dev DB is a safe fallback.
