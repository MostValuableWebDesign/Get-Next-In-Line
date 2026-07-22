---
name: Drizzle migrations
description: How schema changes are applied in this project and the known drizzle-kit path bug.
---

## Rule
Use `drizzle-kit push` (not `generate && migrate`) for non-interactive schema sync — but when the diff includes new tables/renames, `push` also opens an interactive prompt and dies without a TTY. In that case fall back to the manual apply + stamp recovery below.

**Why:** `drizzle-kit push` compares the live DB against the Drizzle schema and applies only the diff — no migration-file tracking required, exits cleanly with no TTY (stdin closed in post-merge context).

**How to apply:** The post-merge script (`scripts/post-merge.sh`) runs `cd lib/db && pnpm exec drizzle-kit push --config ./drizzle.config.ts`. Use the same command for one-off manual syncs.

## Absolute-path double-slash bug (drizzle-kit v0.31)
`drizzle-kit generate/migrate` prepends `./` to paths in `drizzle.config.ts`. When `out` or `schema` is an absolute path (e.g. from `path.join(__dirname, ...)`), this produces `.//home/runner/workspace/...`, causing `ENOENT` on snapshot reads.

**Fix:** Use relative paths in `drizzle.config.ts`:
```ts
schema: "./src/schema/index.ts",
out: "./migrations",
```

## Migration tracking
`drizzle.__drizzle_migrations` tracks applied migration files. If the table is empty but tables already exist (e.g. after a manual schema apply), `drizzle-kit migrate` fails trying to re-create them. Stamp the baseline row manually:
```sql
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('<sha256-of-sql-file>', <journal-when-timestamp>)
ON CONFLICT DO NOTHING;
```

**Silent failures:** `drizzle-kit migrate` can exit 1 (or hang at "applying migrations...") without applying anything and without an error message. After any migrate run, verify expected tables/columns exist. Recovery: apply the pending .sql files manually with psql (in journal order, only the ones whose DDL is actually missing — compare information_schema first), then stamp each pending journal entry's hash into `drizzle.__drizzle_migrations` so migrate stops retrying.

**Keeping push and migrate consistent:** schema changes applied via `drizzle-kit push` must also be captured with `pnpm run generate` and the new migration stamped into `drizzle.__drizzle_migrations` (hash = sha256 of the .sql file, created_at = journal `when`), otherwise a later `migrate` run fails on already-applied DDL.

**Mixed-state recovery:** if a manual migration apply fails mid-file ("column already exists"), re-apply statement-by-statement tolerating pg codes 42701/42P07/42710/42P06/42723, then stamp the hash. Verify with lib/db check-drift afterwards.
