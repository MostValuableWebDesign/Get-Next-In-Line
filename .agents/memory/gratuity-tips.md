---
name: Tip pooling & gratuity ledger
description: Design decisions for the co-op tip-pooling module (rules, ledger scoping, revenue separation)
---

# Tip pooling & gratuity ledger

- Tips are captured at checkout separately from `paymentAmount` and must NEVER enter revenue, commission bases, margin math, or co-op crossover revenue attribution. All allocations live in the gratuity ledger.
- **Ledger tenant scoping rule:** each ledger row is scoped to the STAFF MEMBER'S tenant, not the visit's tenant — on shared co-op visits the partner business's allocations land on the partner's ledger. **Why:** each tenant's tax/export view must only show its own staff's tips.
- Cross-business participation is a heuristic: the most recent `crossover` co-op event at the checkout tenant within the 24h attribution window (partnership still accepted/live) pulls the partner tenant's active staff into the pool. There is no visit↔partnership FK.
- Split rules: equal / percentage (normalized by pool total, NULL/0 excluded, falls back to equal if nobody configured) / role_weighted (NULL = weight 1). Exact-cent math via cumulative rounding so allocations always sum to the tip.
- Visit update + ledger insert commit in one transaction; checkout with a tip but zero active staff is rejected 409 (tip must never be silently dropped).
- **How to apply:** any new checkout path (POS webhooks, bundled visits) that carries a gratuity must reuse `computeTipAllocations`/`resolveTipParticipants` and the same scoping rules.
