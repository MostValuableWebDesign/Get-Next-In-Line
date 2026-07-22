# Memory index

- [Testing admin APIs with curl](api-testing-auth.md) — session cookie is Secure; authenticate over https://$REPLIT_DEV_DOMAIN, not localhost:80.
- [Frontend test auto-cleanup](frontend-test-cleanup.md) — with vitest `globals: false`, RTL auto-cleanup is off; setup must `afterEach(cleanup)`.
- [Drizzle migrations](drizzle-migrations.md) — schema changes go through `pnpm run db:push` (generate+migrate); avoid `drizzle-kit push`, it prompts even with --force in non-TTY shells.
- drizzle-kit v0.31 mishandles absolute `schema`/`out` paths in drizzle.config.ts (double-slash `.//abs/...` ENOENT on snapshots); keep config paths relative — scripts always run with cwd=lib/db.
- Stale `lib/*/dist` .d.ts (db, api-zod) causes phantom "no exported member" typecheck errors in api-server; fix with `npx tsc -b lib/<pkg>`, not code changes.
- [SOS platform decisions](sos-platform.md) — SOS routes intentionally public (no auth yet), simulated-SMS fallback, AI parse fallback, conditional-update concurrency guards.
- [Dev DB drift behind Drizzle schema](dev-db-drift.md) — on missing-column query errors, diff information_schema vs schema and push additive DDL.
- drizzle-kit migrate can exit 1 silently without applying the new migration; verify tables exist afterward, and if needed apply the SQL manually plus insert its sha256 hash/journal `when` into drizzle.__drizzle_migrations.
- api-zod schemas come from a different zod instance than api-server's; `instanceof ZodError` fails across them — duck-type on `err.name === "ZodError"` in error middleware.
- [Validation gates](validation-gates.md) — api-server-test excludes the known-broken SOS inbound-SMS test file; drop the exclude once those webhook tests are fixed.
- orval: an operation with both path and query params generates a zod `<Op>Params` and a TS type `<Op>Params` that collide on re-export; avoid query params on parameterized paths or rename.
- [Artifact path shadowing](artifact-path-shadowing.md) — an artifact's registered path prefix shadows same-prefix routes in the root app; re-path retired artifacts to free the prefix.
- Artifact-managed workflows can't be removed via removeWorkflow; deleting the artifact directory auto-deregisters both the artifact and its workflow.
- mockup-sandbox `vite build` fails (requires PORT at build time), so root `pnpm run build` (-r) always fails at that package; unrelated to other artifacts.
