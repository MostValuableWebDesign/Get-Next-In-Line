---
name: Co-op partnership lifecycle
description: Invite lifecycle rules and tenant scoping for the merchant Local Co-Op Network
---

# Co-op partnership lifecycle

- Partnerships have `status` (pending/accepted/declined) with DB default `accepted` so admin-created and legacy rows never regress; merchant invites are created `pending` + `isActive:false` and only go live via the respond endpoint.
- **Rule:** every customer surface (checkout, receipts, pass views) must read live perks solely from `GET /api/coop/perks` (accepted AND active); never render a perk from partnership lists directly.
- The merchant guardrail compares tenants' sos_settings industry (businessCategory, falling back to industryType), lowercased exact match — distinct from the admin module-category barrier, and has NO tenant-facing override. The UI copy "Same-industry pairings are restricted by platform guidelines." is contractual (tests assert exact text).
- **Tenant scoping:** the frontend `x-tenant-id` header getter and the scope-change cache drop in `sos-tenant.tsx` cover both `/api/sos/` and `/api/coop/` URLs; new tenant-scoped endpoint families must be added there or they silently run unscoped.
- **Why:** pending/declined invites surfacing anywhere is a product violation; PATCH refuses `isActive:true` unless status is accepted to enforce it server-side.
- `GET /api/coop/perks` returns `{ disclaimer, perks }` (not a bare array); the platform liability disclaimer has a single source in the api-server coop perks lib and must accompany every perk surface — never hardcode the text in the frontend.
- Perks have optional start/end windows (NULL = always active); all perk-serving queries and redemption validation filter by the window, and a worker-tick sweep archives expired perks (isActive=false, never deleted; hub shows "Expired").
- Redemption locking: unique (partnership, passCode) row inserted with onConflictDoNothing — the QR payload is `CODE|PASSCODE`; a pass instance redeems exactly once even under concurrent scans.
