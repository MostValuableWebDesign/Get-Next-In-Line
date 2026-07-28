---
name: Dev DB drift behind Drizzle schema
description: What to check when queries fail with missing-column errors in dev
---

The dev database can drift behind the Drizzle schema — columns get added in code but never pushed.

**Why:** schema files are the source of truth, but nothing forces a push, so "Failed query" / "column does not exist" errors show up at runtime.

**How to apply:** on such errors, compare `information_schema.columns` with the Drizzle schema and apply the missing additive DDL (or run the project's non-interactive push script, e.g. `pnpm run db:push` — see [Drizzle migrations](drizzle-migrations.md)).

## Triggers/functions can silently vanish (checkpoint restore)
Drift isn't only columns: a checkpoint DB restore can drop triggers and plpgsql functions (e.g. the platform-ledger append-only guard) while `db:check-drift` and server-startup reconcile stay green — they only track migration stamps/columns. Symptom: an immutability/behavioral test suddenly fails on clean main. Fix: re-run the trigger's DDL block from its original migration file (the `CREATE OR REPLACE FUNCTION` + `CREATE TRIGGER` statements are idempotent-safe to replay).

## Recovering partially-applied out-of-band migrations
When pending migrations are *partially* applied out-of-band (e.g. DB rolled back), `db:push` fails with "already exists" and `--mark-applied` alone only helps fully-applied ones — do NOT mark everything applied without verifying. Recovery: replay each pending migration statement-by-statement (split on `--> statement-breakpoint`), tolerating only duplicate-object SQLSTATEs (42P07/42701/42710/42P16), then `pnpm run migrate -- --mark-applied <file>` per migration, and confirm with `pnpm run db:check-drift`. Run helper scripts from inside `lib/db` so `pg` resolves. db:push now runs check-drift automatically after migrate, so this state fails loudly.

## Recovering a dev DB with partial out-of-band DDL and stale bookkeeping
When many migrations fail with "already exists" (schema partly applied out of band), don't hand-run whole files: execute each pending migration statement-by-statement via psql, skipping only "already exists" errors, then `pnpm run migrate -- --mark-applied <file>` for each, and finish with `pnpm run db:push` + `db:check-drift` to confirm.
