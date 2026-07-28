---
name: Co-op Reputation Shield
description: Invariants for the internal B2B rating loop (flag/decouple/reinstate) and decoupled-tenant exclusions.
---

- B2B partner ratings are strictly internal: served only via tenant-scoped `/coop/*` and admin routes; leak tests grep public landing HTML + perks JSON for markers like "reliability"/"reputation" — never use those words in test fixture names (perk titles etc.) or the leak assertions false-positive.
- **Decoupled-tenant exclusion** is read-side: every discovery/consumer read (directory, suggestions, `/coop/perks`, redemption validate+redeem, public landing perks) must filter via `decoupledTenantIdSet()` in `lib/coopReputation.ts`. Add the filter to any NEW co-op read surface.
- Decouple deactivates a tenant's accepted partnerships and records their ids in the `decoupled` audit event's `details.partnershipIds`; admin reinstate reactivates exactly those ids (never a blanket `isActive=true`, which would override merchants' manual deactivations).
- Lifecycle: ok → flagged (owner alert, kind `coop_reputation`) → decoupled after grace window → admin reinstate only. Flags auto-clear on recovery; decoupled never auto-clears.
- **Decouple is also write-side**: any path that can set a partnership `isActive=true` (participant resume, future reactivation flows) must reject with 409 while either party is decoupled — reinstatement is admin-only; `/coop/perks` additionally filters decoupled tenants as defense in depth.
- One CURRENT rating per rater→rated pair is DB-enforced by a partial unique index (`where is_current`); a new rolling period supersedes (flips `is_current=false`) rather than updating, keeping history for audit. Scoring uses current rows only, recency-weighted (half-life 30d), with a min-distinct-rater floor.
- Worker tick results are compared structurally in the concierge advisory-lock test: keep tick result shapes stable, or update every exact-equality assertion when extending them.
