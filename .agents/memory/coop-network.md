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

## Platform invites (off-platform businesses)
- Trackable link is `/api/join/:token` (public, campaignRedirect-style) → marks clicked → 302 to SPA `/join/:token`; tokens are 48-char lowercase hex.
- Single-use guard: registration consumes the invite via a conditional UPDATE (`status in ('sent','clicked')`) inside the same transaction that creates the tenant/storefront/partnership — losers of the race roll back cleanly.
- Expiry is computed lazily (`effectiveInviteStatus`) — no sweeper flips rows to expired; never trust the raw `status` column alone for display or registration gating.
- Auto-created partnership respects the same-industry guardrail by comparing the inviter's sos_settings category to the registrant's submitted category; registration still succeeds when blocked (partnershipCreated=false).

## Redemption integrity & attribution
Rule: every redemption write path — the native co-op redemption route AND POS webhook wallet-pass processing — must (1) verify the redeeming tenant is a party to the partnership, (2) enforce direction-aware tracking codes are redeemed by the receiving side only (host code → partner scans; partner code → host scans), and (3) record at most one attribution event per redemption (unique redemption_id).
**Why:** completion code review rejected the attribution feature twice for forgeable metrics — outsiders or self-scans could inflate sent/received counts, and the POS webhook path silently bypassed the checks added to the native route.
**How to apply:** when adding any new surface that redeems perks/passes (new webhook vendor, kiosk, API), route it through the same participant + direction checks and insert attribution via the unique redemption_id lock; reject without writes on mismatch.
## Plaza exclusivity
Rule: same-plaza category exclusivity is enforced in BOTH directions at invite time; the `PLAZA_EXCLUSIVITY_RESTRICTED` message text is contractual (mirrored in UI and tests); admin release applies to the exact (requester, partner, category) direction only and must never be resurrected by later blocked attempts. Plaza-conflict list/release endpoints are platform-admin-only.
**Why:** releases are deliberate dispute resolutions per pairing — a broader release would silently void exclusivity for uninvolved businesses, and a member-accessible release is a privilege escalation (caught in review).
**How to apply:** any new surface that creates partnerships (accept flows, admin creation, campaigns) must run the same both-direction check and honor releases; keep admin-only classification in tenantAccess for new conflict-console routes.
