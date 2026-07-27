---
name: Platform compliance ledger
description: Append-only ledger invariants — trigger vs FK SET NULL, capture conventions, canonical CSV export
---

# Platform compliance ledger

- The `platform_ledger_entries` table is append-only, enforced by a DB trigger. **Why:** compliance figures must be reproducible/auditable, never recomputed differently per screen.
- **Trigger vs FK gotcha:** `ON DELETE SET NULL` on the tenant FK performs an UPDATE on the ledger row, which a naive append-only trigger rejects — breaking every tenant deletion (and test cleanup). The trigger explicitly permits the exact detach (tenant_id → NULL, all other columns unchanged) and blocks everything else.
- **How to apply:** any new append-only table with a SET NULL/SET DEFAULT FK needs the same carve-out in its guard trigger.
- Capture is via `recordLedgerEventsSafe` / `recordDepositOutcomeSafe` — insert with `onConflictDoNothing` on (source, source_ref), log loudly, never throw, so ledger failures can't break checkouts.
- The canonical export is the server-side CSV at the admin compliance endpoint; the old client-side module ledger CSV utility was removed. Don't reintroduce client-computed exports.
- Ledger amounts/margins are persisted realized figures (charged wholesale/resale at checkout); partner-category subscriptions always record zero platform margin.
- Integration tests can't delete ledger rows (immutable); cleanup deletes tenants only and the FK nulls out — assert only on rows/tenants the test created.
