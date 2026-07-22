---
name: Drizzle migrations
description: How schema changes are applied in this project and the known drizzle-kit path bug.
---

## Rule
Use `drizzle-kit push` (not `generate && migrate`) for non-interactive schema sync.

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
