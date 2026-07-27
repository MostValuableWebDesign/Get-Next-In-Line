---
name: Franchise Co-Op Controller
description: Durable design decisions for the multi-location franchise org module.
---

- Franchise HQ template perks are **self-paired partnership rows** (host === partner), deliberately exempted from the co-op consumer-surface firewall — a tenant vs itself would otherwise be blocked as a same-sub-category competitor. Never create self-pairs outside the propagation engine.
- **Why:** perks must surface through the existing consumer perk endpoints (checkout, receipts, passes) unchanged.
- Franchise org roles are org-scoped only, NOT tied to tenant memberships. Attaching a tenant to an org requires explicit proof of control (platform admin or membership of that tenant) — org super-admin status alone must never suffice.
- Franchise-originated local partnerships must go through the exact same safeguards as merchant-created invites: same-industry firewall, pending+inactive lifecycle, tracking codes at insert time. The org hierarchy is never a bypass of platform co-op rules.
- platform_ledger_entries is append-only (DB trigger) — tests must never DELETE from it; deleting test tenants nulls tenant_id, which is enough isolation.
