---
name: messages.origin classification
description: How operational vs concierge messages are distinguished in the unified messages table
---

# messages.origin

The unified `messages` table has an `origin` column with values `'operational'` and `'concierge'` that classifies which surface a message belongs to. `tenant_id` is stamped on operational sends too.

**Why:** tenant_id NULL/NOT NULL was previously used as an implicit "concierge marker"; once operational sends started carrying tenant_id, that heuristic silently misclassified rows.

**How to apply:** whenever filtering messages by surface (dashboards, reports, comms logs), filter on `origin`, never on tenant_id nullability. Tenant scoping is a separate, orthogonal filter on `tenant_id`.
