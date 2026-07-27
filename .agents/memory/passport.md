---
name: Neighborhood Passport
description: Cross-tenant consumer passport (stamps/challenges/rewards) — identity model, stamping hooks, test cleanup rules.
---

# Neighborhood Passport

- Passport identities are **global** (no tenant FK), keyed on unique normalized phone (E.164) / lowercased email. Tenant cascade deletes do NOT clean them — integration tests must delete identities by their per-run phone block in afterAll.
- **Why:** identities deliberately span tenants (cross-business stamping); leaving test identities behind pollutes phone-unique constraints for later runs.
- Every perk-redemption write path (coop.ts wallet + classic, posEvents webhook) must call `recordPassportStampSafe` — it never throws, so passport bookkeeping can't block a redemption. Any NEW redemption path must add the same hook.
- Exactly-once rewards: unique (challengeId, identityId) on passport_reward_issuances + `onConflictDoNothing().returning()` — a missing returned row means "already issued", skip notification.
- Backfill (startup) creates stamps only — never evaluates challenges or sends SMS, to avoid retroactive blasts; the next live stamp evaluates against full history.
- Reward SMS uses messaging kind `passport_reward` with origin `marketing` (hidden from operational message lists by design).
- Opt-out is network-wide for passport texts: a STOP on ANY sos_customer or client_profile with the phone suppresses the reward SMS (reward row still issues). Split phone/email identities are merged transactionally into the phone-matched row (stamps/rewards re-parented via onConflictDoNothing).
