---
name: SOS tenant scoping
description: How tenant context flows through SOS operational routes and data.
---

- SOS operational tables (customers, visits, appointments, waitlist, calls, resources) carry a nullable `tenant_id`; NULL = legacy single-tenant rows.
- Tenant context is passed as the `x-tenant-id` request header (chosen over query params because orval collides on query params for parameterized paths). No header → strict legacy scope (NULL-tenant rows only, never unscoped).
- **Why:** settings are per-tenant; operational flows must resolve the right tenant's settings (`resolveSettings(tenantId)`) so one tenant's receptionist toggle/service names govern only its own queue.
- Direct-ID routes (get/patch/delete/cancel/claim/renew by id) must also carry the strict tenant predicate — list scoping alone fails code review as bypassable broken access control. Rows without their own tenant column (plan enrollments, operational messages) inherit scope via a join to their customer.
- **How to apply:** ALL SOS reads and cross-row mutations use *strict* matching (`tenantMatch`): with context only that tenant's rows, without context only NULL-tenant legacy rows — never unscoped. Writes stamp tenant from the parent customer/appointment row when one exists, else the header. Code review rejects any unscoped fallback as a cross-tenant leak.
