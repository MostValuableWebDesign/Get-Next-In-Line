---
name: User↔tenant authorization policy
description: Durable rules for tenant-scoped access control (members vs platform admin) that new routes must honor.
---

- One shared middleware (mounted right after session auth) authorizes every *acting* tenant reference a request carries — the tenant header, tenant URL params, tenant query params, and acting-tenant body fields — against the user's tenant memberships; platform admins pass everywhere.
- **Why:** authentication used to be a single session flag, so any session could act on any tenant. Centralizing keeps header/param/body scoping consistent and makes new routes safe by default.
- **How to apply:** new tenant-scoped routes need no per-route check if they use the standard tenant references. If a new body field carries acting-tenant scope, register it in the middleware's ref resolver. Counterparty tenant fields (e.g. a co-op invite's partner) are deliberately NOT checked — referencing another tenant is legitimate; acting as them is not.
- Password (ADMIN_PASSWORD) login must stay DB-free: it creates a platform-admin session with no user id, and such sessions are treated as the platform operator. Several unit tests mock the db package, so login must not query it.
- Non-admin sessions come from token login (`users.login_token`) — the programmatic seeding path for members until a user-management UI exists.
- Requests with no tenant reference run in the legacy NULL-tenant scope and are member-accessible. Any endpoint returning cross-tenant aggregates (agency/admin consoles, billing summary, module rosters, unscoped tenant/partnership lists or activity feeds) must be classified platform-admin-only in the middleware — a code review rejected this task once for missing the billing summary.
