---
name: Co-op Marketing Hub
description: Design decisions for the co-op marketing & syndication hub (campaigns, channels, dispatch, analytics)
---

# Co-op Marketing Hub decisions

- **Send-once lock**: campaign dispatch claims `dispatch_triggered_at IS NULL` with a conditional update (same pattern as coop campaign blasts). All dispatch paths (route + worker sweep) go through `dispatchMarketingCampaign`; never add a second write path.
- **Why:** double-dispatch would double-text both partners' subscriber lists.
- **Approval gating**: creator is auto-approved; campaign moves pending_approval→scheduled only when every participant approved; decline is terminal (status declined). Respond uses a conditional update → 409 on double-respond.
- **Simulated social**: live posting only when `META_GRAPH_ACCESS_TOKEN` is set (`socialPostingMode()`); simulated sends carry a deterministic hash-based `simulatedImpressions` and are flagged `simulated` end-to-end in analytics (simulatedReach).
- **Channel access tokens** live in `coop_marketing_channels.access_token` and must never be serialized in responses.
- **Tracked links**: `/api/mr/:code` (public, before auth), codes `mk`+12hex; one link row per (tenant, channel) target; clicks best-effort insert, 302 to the tenant landing page.
- **Branding**: tenant logo stored as a client-resized data URL in `sos_settings.brand_logo_url` (max ~400KB, pattern-guarded in OpenAPI); defaults #1e3a5f/#f4a259 when unset. Assets render client-side on canvas — no server-side image generation.
- **How to apply:** any new syndication channel or redemption-like send path must reuse `dispatchMarketingCampaign` targets, write a link row, and respect the sms opt-in guard via `sendMessageSafe` kind `coop_marketing_blast`, origin `marketing`.
