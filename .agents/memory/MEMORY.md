# Memory index

- [Testing admin APIs with curl](api-testing-auth.md) — session cookie is Secure; authenticate over https://$REPLIT_DEV_DOMAIN, not localhost:80.
- [Frontend test auto-cleanup](frontend-test-cleanup.md) — with vitest `globals: false`, RTL auto-cleanup is off; setup must `afterEach(cleanup)`.
- [Drizzle migrations](drizzle-migrations.md) — schema changes go through `pnpm run db:push` (generate+migrate); avoid `drizzle-kit push`, it prompts even with --force in non-TTY shells.
- drizzle-kit v0.31 mishandles absolute `schema`/`out` paths in drizzle.config.ts (double-slash `.//abs/...` ENOENT on snapshots); keep config paths relative — scripts always run with cwd=lib/db.
- Stale `lib/*/dist` .d.ts (db, api-zod) causes phantom "no exported member" typecheck errors in api-server; fix with `npx tsc -b lib/<pkg>`, not code changes.
- [SOS platform decisions](sos-platform.md) — SOS routes intentionally public (no auth yet), simulated-SMS fallback, AI parse fallback, conditional-update concurrency guards.
- [Dev DB drift behind Drizzle schema](dev-db-drift.md) — on missing-column query errors, diff information_schema vs schema and push additive DDL.
- [SOS tenant scoping](sos-tenant-scoping.md) — `x-tenant-id` header carries tenant context; NULL tenant_id = legacy rows; strict NULL-vs-tenant matching in broadcasts.
- [Drizzle silent migrate failures](drizzle-migrations.md) — migrate can exit 1 silently; verify tables, apply SQL manually, stamp hash/`when` into drizzle.__drizzle_migrations. Hash = sha256 of the migration .sql contents.
- api-zod schemas come from a different zod instance than api-server's; `instanceof ZodError` fails across them — duck-type on `err.name === "ZodError"` in error middleware.
- [Validation gates](validation-gates.md) — api-server-test now runs the full suite (exclude removed); fix red suites at root cause (often DB drift) instead of excluding.
- orval: an operation with both path and query params generates a zod `<Op>Params` and a TS type `<Op>Params` that collide on re-export; avoid query params on parameterized paths or rename.
- [Artifact path shadowing](artifact-path-shadowing.md) — an artifact's registered path prefix shadows same-prefix routes in the root app; re-path retired artifacts to free the prefix.
- Artifact-managed workflows can't be removed via removeWorkflow; deleting the artifact directory auto-deregisters both the artifact and its workflow.
- Concierge worker tick runs under pg_try_advisory_xact_lock (tx-scoped, auto-released on crash) and reaps stale "pending" messages to failed so retries aren't suppressed; keep new schedulers on runConciergeTick.
- api-server integration tests run in parallel and share the legacy (tenant_id NULL) sos_settings row: mutate only the fields under test, never flip waitlistAutoFillEnabled, and use unique per-run service names so cancellations don't match other tests' waitlist entries.
- mockup-sandbox `vite build` fails (requires PORT at build time), so root `pnpm run build` (-r) always fails at that package; unrelated to other artifacts.
