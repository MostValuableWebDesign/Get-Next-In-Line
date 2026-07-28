---
name: Co-op Sponsorship Hub
description: Boost/auction lifecycle, revenue-share split rules, and wallet/payout invariants for the co-op sponsorship feature.
---

- Boost lifecycle: flat boosts are charged immediately (active if window started, pending if future); bids stay pending until the window opens, then `resolveCoopBoosts(now)` settles per exact (surface, startsAt, endsAt) — highest amount wins (tie: earliest createdAt, then id); only the winner is charged; losers → `lost`, past-end actives → `expired`.
- **Rendering reads real time**, not the injected `now` passed to `resolveCoopBoosts` — featured flags only appear once the wall clock is inside the boost window. Tests must use near-now windows and wait for them to open (see coop-sponsorship.integration.test.ts).
- Revenue share: `percent` splits apply to `revenueShareBaseAmount` (agreed nominal per-redemption value — no real transaction amount exists at redemption time). Redeeming tenant pays gross; partner earns net of the platform fee. Split application is idempotent per redemption and never throws (logs loudly).
- Platform fee (`agencySettings.coopPlatformFeePercent`) is a single shared global row — tests that assert split math must pin it first and compute expectations from it; parallel tests changing it can race.
- Wallet balance = sum of `pending`-status entries; operator payout flips them to `paid_out` in one tx and appends a negative payout entry; 409 when balance ≤ 0.
- Boost purchases and split fees are mirrored into the platform compliance ledger (`coop_boost`, `coop_split_fee` sources).
- Featured placement never bypasses the firewall/proximity filters — it only stable-sorts already-visible entries/perks to the top.
- Adding fields to shared responses (directory entries, ConciergeTickResult) breaks exact-shape assertions in coop-invites and concierge-worker tests — update those expectations in the same change.

**Why:** these invariants are contractual for split accounting; violating the rendering/real-time rule or the shared-fee-row rule makes tests flaky in non-obvious ways.
**How to apply:** any change to boosts, splits, wallet, or payout endpoints, and any test touching /coop/sponsorship or /admin/coop.

## Cross-suite pause hazard
Shifted-clock tier evaluations must be scoped: `evaluateCoopPartnershipTiers(future, { partnershipIds })` — an unscoped future-clock run performance-pauses every zero-traffic partnership DB-wide and breaks unrelated parallel suites whose perks must render. Also: compute near-now auction windows inside the test body, not at collection time — slow parallel runs age a collection-time `Date.now()+4s` start into the past and bids 400.
