---
name: Co-op campaign blasts
description: Design constraints for co-op flash campaigns and the joint SMS blast frequency cap
---

- The `blast_triggered_at IS NULL` conditional update on coop_campaigns is the send-once lock shared by the manual trigger route and the concierge auto-fire sweep — any new blast entry point must claim it the same way.
- **Why:** the worker tick and a manual trigger can race; without the claim the network gets double-texted.
- The coop_campaign_blasts ledger is keyed by normalized E.164 phone and is written BEFORE dispatch (deliberately conservative — a crash mid-blast may under-send but never spam on retry). The 7-day cap check is network-wide (any campaign, any tenant).
- Blast messages use `origin: "marketing"` — intentionally excluded from the operational/concierge message list surfaces, which filter on origin; assert storage via SQL in tests, not via list endpoints.
- **How to apply:** any new marketing-style outbound (promos, announcements) should reuse the "marketing" origin and consider the same phone-keyed cap ledger pattern.
