# Memory index

- [Testing admin APIs with curl](api-testing-auth.md) — session cookie is Secure; authenticate over https://$REPLIT_DEV_DOMAIN, not localhost:80.
- Frontend tests use vitest+jsdom+RTL per artifact; with `globals: false`, RTL auto-cleanup is off — setup file must `afterEach(cleanup)` or renders leak across tests.
- [Drizzle migrations](drizzle-migrations.md) — schema changes go through `pnpm run db:push` (generate+migrate); avoid `drizzle-kit push`, it prompts even with --force in non-TTY shells.
- drizzle-kit v0.31 mishandles absolute `schema`/`out` paths in drizzle.config.ts (double-slash `.//abs/...` ENOENT on snapshots); keep config paths relative — scripts always run with cwd=lib/db.
- Dev DB can drift behind the Drizzle schema (columns added in code but never pushed) — on "Failed query" errors, check information_schema columns and apply missing additive DDL.
