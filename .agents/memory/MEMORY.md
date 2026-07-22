# Memory index

- [Testing admin APIs with curl](api-testing-auth.md) — session cookie is Secure; authenticate over https://$REPLIT_DEV_DOMAIN, not localhost:80.
- Frontend tests use vitest+jsdom+RTL per artifact; with `globals: false`, RTL auto-cleanup is off — setup file must `afterEach(cleanup)` or renders leak across tests.
- [Drizzle migrations](drizzle-migrations.md) — use `drizzle-kit push` for non-interactive schema sync; `generate+migrate` hits a double-slash ENOENT bug with absolute paths in drizzle-kit v0.31.
- Dev DB can drift behind the Drizzle schema (columns added in code but never pushed) — on "Failed query" errors, check information_schema columns and apply missing additive DDL.
