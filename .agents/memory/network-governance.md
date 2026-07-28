---
name: Network governance roles
description: Four-tier role system (super_admin, district_manager, merchant, staff) and the co-op join-application flow
---

## Roles & scope
- Roles live on `users.role`; tenant scope reuses `user_tenant_memberships` (no separate scope table). Cardinality enforced only at the governance API: merchant/staff exactly 1 tenant, district_manager ≥ 1, super_admin none.
- `role === "super_admin"` must stay in sync with `isPlatformAdmin` on user rows; legacy password sessions (no userId) are treated as super_admin so the bootstrap login never breaks.
- Session role is set at login (`finishLogin`) and returned by `GET /auth/me`; frontend caches it module-level in `useSessionRole()` — frontend tests that mock `@/hooks/useAuth` must also mock `useSessionRole`.
- Enforcement split: `middlewares/roles.ts requireRole()` for governance routes; `middlewares/tenantAccess.ts` for the role-aware tweaks (staff read-only on /tenants + /coop writes; GET /tenants list open to all roles because the route filters to memberships).
**Why:** one membership table keeps district/merchant/staff scoping on the same authorization path that already guards every tenant ref.
**How to apply:** new role-gated surfaces should use `requireRole`; never re-open a platform-admin-only path per-role without a scoped filter in the route itself.

## Join applications
- `coop_applications` transitions: submitted → under_review → approved/rejected (submitted may skip straight to a decision); decided states are terminal. Rejection requires a reason; approval provisions the tenant inside a conditional-status-claim transaction (same shape as POST /tenants + sosSettings + activity log) so concurrent approvals can't double-provision.
- Applicant status page is keyed by a 32-hex statusToken; only rejectionReason is exposed publicly — reviewNotes stay internal.
- The bootstrap "operator" user row is protected from edit/delete in the governance API.
