---
name: Drizzle migration conflicts on task rebase
description: How to resolve parallel-task collisions on migration numbers/snapshots when rebasing onto main
---

When two tasks each generate the same-numbered Drizzle migration, the rebase conflicts on `_journal.json` + `meta/00NN_snapshot.json` (and often generated API clients).

**Rule:** never hand-merge migration meta. Keep main's migration set verbatim, drop your own migration file + snapshot + journal entry, then regenerate yours on top:
1. During the rebase, remember `--ours` = main, `--theirs` = your task commit. Take main's snapshot/journal (`git checkout main-repl/main -- lib/db/migrations/meta/...`).
2. Delete your old migration .sql, trim journal entries back to main's last idx (node one-liner; python3 is not installed).
3. `drizzle-kit generate` in lib/db to produce the next-numbered migration from the merged schema — verify it contains only YOUR tables (if it contains main's tables, the snapshot resolution was backwards).
4. Dev DB will have a stale `drizzle.__drizzle_migrations` hash for the deleted file: delete that one row via psql, then `pnpm -w run db:reconcile` (applies main's migration, stamps yours skipping existing DDL).
5. Regenerate orval clients from the merged openapi.yaml (`pnpm run codegen` in lib/api-spec) instead of hand-merging generated files.

**Why:** snapshots are cumulative diff baselines; hand-merged snapshots make every future `generate` wrong.

Also: background sweep jobs that iterate all tenants (e.g. monthly co-op reports) must tolerate FK violations (code 23503) from tenants deleted concurrently — parallel test suites tear tenants down mid-run.
