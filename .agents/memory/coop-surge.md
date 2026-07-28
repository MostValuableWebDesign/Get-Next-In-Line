---
name: Co-op surge pricing & capacity status
description: Design invariants for capacity status + surge boost engine
---
- Capacity status (`lib/capacityStatus.ts` in api-server) is cached in-process for 30s; integration tests must call `__clearCapacityStatusCache()` after mutating queue/override state or assertions read stale status.
- Surge double-activation lock is the partial unique index on `coop_surge_activations(rule_id) WHERE ended_at IS NULL` + `onConflictDoNothing` — keep any new activation path on that insert.
- **Why:** sweeps can run concurrently (interval + BullMQ); DB-level lock is the only safe idempotency guard.
- Industry-barrier firewall is enforced twice by design: at rule-creation API AND again at sweep time (backstop for rows inserted out-of-band or pairs reclassified later). Firewall profiles come from sos_settings coopSubCategory — tenants without classification are unclassified and never blocked, so tests must seed coopSubCategory to exercise blocking.
- Boost metadata (`surge` on perk items) attaches to the partnership perk for both sides' feeds; deleting a rule cascades activations (live boost reverts, history for that rule is lost — accepted tradeoff).
