---
name: Partner-Direct Integrations
description: Conventions for the partner connections proxy engine and pass-through billing.
---

- Partners-category modules bill at strict pass-through: `effectiveMarkupPercent` returns 0 whenever `categorySlug === "partners"`, regardless of the stored per-module override or agency markup. **Why:** billing contract with partners; a bogus DB override must never mark up a partner module. **How to apply:** never bypass `effectiveMarkupPercent` in pricing/checkout surfaces.
- Partner proxy routes live under `/api/v1/partners/{partnerId}` where partnerId is a URL-safe key derived from the customer-facing `partnerBrand` (e.g. `next-insurance`) — never the internal module slug (hidden-connector field).
- Credential tokens are AES-256-GCM encrypted (`partnerCrypto.ts`, key derived from SESSION_SECRET) and stored in `partner_connections`; no API response may include token or oauthState fields — tests deep-scan responses for leakage.
- Session-auth bypasses with dynamic path segments (e.g. partner webhooks) go in `SESSION_EXEMPT_PATTERNS` (regex list) next to `SESSION_EXEMPT_PATHS` in routes/index — same guarded-growth rule: every entry needs its own auth story.
- Partner connections follow the SOS tenant-scoping convention (`x-tenant-id` header, NULL = agency-level workspace) with a NULLS NOT DISTINCT unique on (tenant_id, module_id).
