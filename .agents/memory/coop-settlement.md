---
name: Co-op settlement clearinghouse
description: Obligation ledger, pairwise netting, settlement cycles — invariants for the Master Overview / clearinghouse.
---

# Co-op settlement clearinghouse

- **Obligation hooks** live in the single redemption accounting choke point (`applyRedemptionSplitSafe`) and the event-expense route; any NEW co-op money event that creates a cross-business balance must call `recordObligationsSafe` with a unique `(kind, sourceRef)` — that pair is the idempotency key.
  **Why:** double-inserted obligations silently inflate settlement statements; the unique constraint is the only guard.
- **Settlement immutability is enforced by absence of mutation routes** (no DB trigger). Never add PATCH/PUT/DELETE under `/agency/settlement/cycles`; a test asserts these 404.
- Settlement run: one transaction + `pg_try_advisory_xact_lock(0x7365746c)` + `FOR UPDATE` + a `settlement_cycle_id IS NULL` conditional stamp; the stamp-count mismatch throws to roll back rather than under-count.
- Netting math is integer-cents (`netObligations`); per-cycle statement netAmounts always sum to zero — keep that invariant in any change.
- HQ template perks are self-paired partnerships (host===partner): excluded from obligations and from Master Overview partnership counts.
