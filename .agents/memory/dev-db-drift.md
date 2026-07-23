---
name: Dev DB drift behind Drizzle schema
description: What to check when queries fail with missing-column errors in dev
---

The dev database can drift behind the Drizzle schema — columns get added in code but never pushed.

**Why:** schema files are the source of truth, but nothing forces a push, so "Failed query" / "column does not exist" errors show up at runtime.

**How to apply:** on such errors, compare `information_schema.columns` with the Drizzle schema and apply the missing additive DDL (or run the project's non-interactive push script, e.g. `pnpm run db:push` — see [Drizzle migrations](drizzle-migrations.md)).

## Recovering partially-applied out-of-band migrations
When multiple pending migrations are each *partially* applied out-of-band, `--mark-applied` only helps for fully-applied ones. Recovery: replay each pending migration statement-by-statement, tolerating only duplicate-object SQLSTATEs (42P07/42701/42710/42P06), stamp bookkeeping, then run check-drift to prove the final schema matches. db:push now runs check-drift automatically after migrate, so this state fails loudly.
