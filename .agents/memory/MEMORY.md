# Memory index

- [Testing admin APIs with curl](api-testing-auth.md) — session cookie is Secure; authenticate over https://$REPLIT_DEV_DOMAIN, not localhost:80.
- [Frontend test auto-cleanup](frontend-test-cleanup.md) — with vitest `globals: false`, RTL auto-cleanup is off; setup must `afterEach(cleanup)`.
- [Drizzle migrations](drizzle-migrations.md) — schema changes go through `pnpm run db:push` (generate+migrate); avoid `drizzle-kit push`, it prompts even with --force in non-TTY shells.
- drizzle-kit v0.31 mishandles absolute `schema`/`out` paths in drizzle.config.ts (double-slash `.//abs/...` ENOENT on snapshots); keep config paths relative — scripts always run with cwd=lib/db.
- Stale `lib/*/dist` .d.ts (db, api-zod) causes phantom "no exported member" typecheck errors in api-server; fix with `npx tsc -b lib/<pkg>`, not code changes.
- [SOS platform decisions](sos-platform.md) — SOS routes intentionally public (no auth yet), simulated-SMS fallback, AI parse fallback, conditional-update concurrency guards.
- [Dev DB drift behind Drizzle schema](dev-db-drift.md) — on missing-column query errors, diff information_schema vs schema and push additive DDL.
- [Artifact path shadowing](artifact-path-shadowing.md) — an artifact's registered path prefix shadows same-prefix routes in the root app; re-path retired artifacts to free the prefix.
