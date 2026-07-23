---
name: Dev DB checkpoint rollback self-heal
description: Why "Repair dev DB drift" recurs and how startup self-heals it now
---

# Dev DB checkpoint rollback self-heal

**The rule:** The recurring "dev DB drift / N unstamped migrations" state is caused by Replit checkpoint restores rolling the dev database back to an older snapshot while code + migrations stay newer. It is NOT data loss from the migration runner — reconcile mode is strictly additive-forward (savepoint-skips only "already exists" errors, never drops/rewinds).

**Why:** User perceived reconcile as "wiping the partner modules table"; investigation showed data intact and no destructive path in the migrate/reconcile scripts. The real gap was that startup only *logged* drift, so seeds could fail against missing columns until someone manually ran db:reconcile.

**How to apply:** API server startup now self-heals: `checkSchemaDrift` → if behind, `applyPendingMigrations(pool, { reconcile: true })` (shared logic in `lib/db/src/apply-migrations.ts`, also used by the CLI in `lib/db/scripts/migrate.ts`) → re-check → then `seedConnectorMapping()` runs AFTER repair so brand/connector/markup backfill lands in repaired columns. Keep new startup seeds sequenced after the schema repair. Don't add duplicate repair machinery — extend `applyPendingMigrations` if needed.
