---
name: Co-op tip pooling
description: Design rules for the gratuity splitter — rule resolution order, gating, rounding, and ledger immutability.
---

- Rule resolution at checkout: bundle→partnership rule (only while partnership is accepted + isActive + not disputeSuspended/banned) → tenant group_event rule → default whole tip to servicing staff (ruleId NULL). Gating is re-checked at checkout time, so a paused/declined partnership stops splitting even with a live rule.
- **Why:** cross-tenant money attribution must never survive a dead partnership; rules are not deleted, they just stop matching.
- Allocation math is integer cents: floor each share, all remainder cents to the servicing staff participant (else first participant). Ledger rows are immutable and snapshot the rule terms (ruleSnapshot jsonb) — never re-split retroactively.
- Origin (own vs partner) is derived at read time from sourceTenantId === recipientTenantId, not stored.
- Ledger writes happen inside the same db.transaction as the visit check_out update (routes/sos.ts advance route).
- /sos/tip-pooling/* routes rely on the frontend's automatic x-tenant-id injection (URL contains "/api/sos/"). Only the rule's owner tenant edits it; both partnership sides can view.
- Staff earnings `sharedTipsEarned` comes solely from the gratuity ledger — never folded into commission or attributedRevenue.
- Visit advance is single-winner: the status transition is a conditional update (`WHERE status IN transition.from`) inside the checkout transaction; plan-benefit writes and gratuity ledger only run after the winning row returns, and a (visit_id, recipient_staff_id) unique index is the DB idempotency backstop. Code review rejects checkout side effects that run before the conditional transition confirms.
