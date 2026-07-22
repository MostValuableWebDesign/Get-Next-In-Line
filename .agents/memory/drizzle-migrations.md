---
name: Drizzle schema changes — migrations, not push
description: How to apply DB schema changes non-interactively and why drizzle-kit push is banned here
---

The dev DB schema flow is generate + migrate, not `drizzle-kit push`.

**Why:** `drizzle-kit push` (CLI and `drizzle-kit/api pushSchema`) prompts interactively for risky changes (e.g. adding a unique constraint to a populated table) even with `--force`, and dies with a TTY error in non-interactive shells. This caused the dev DB to silently drift behind the code schema.

**How to apply:** Run `pnpm run db:push` from root (drizzle-kit generate + migrate against `lib/db/migrations`; baseline migration is marked applied in `drizzle.__drizzle_migrations`). Verify with `pnpm run db:check-drift`; the API server also logs a drift warning at startup via `checkSchemaDrift` exported from `@workspace/db`. Note `drizzle-kit generate` can still prompt on ambiguous column renames — it fails loudly, not silently.
