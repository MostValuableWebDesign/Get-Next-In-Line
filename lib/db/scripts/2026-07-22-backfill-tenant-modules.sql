-- One-time backfill: represent pre-existing tenants' module assignments in tenant_modules.
-- Context: tenant_modules was introduced after several tenants were provisioned, so those
-- tenants had tenants.modules_enabled > 0 but no join-table rows. Module consoles therefore
-- showed 0 subscribers and duplicate-provisioning protection didn't cover them.
--
-- Sources for the module lists:
--   Tenant 1 (Apex Digital Media, 7 modules)  — exact list from tenant_activities
--     ("Modules provisioned" on 2026-06-25): Lead Pipelines & CRM Core, Smart Booking System,
--     AI Voice & SMS Nurture Bots, Complete Payroll & Tax Suite, Connected TV & OTT Ad Network,
--     AI Voice & Audio Script Synthesis, Automated AI Video Ad Generator.
--   Tenant 3 (Velocity Creative, 4 modules)   — exact list from tenant_activities (2026-07-06):
--     Unified Omnichannel Inbox, No-Show Shield & Deposits, Commission & Split Tracker,
--     Programmatic Digital Audio Ads.
--   Tenant 2 (Summit Agency Group, 11 modules) — activity log only says "Full marketing and
--     operations suite"; reconstructed as the Marketing OS bundle (1-4), the Core Service
--     operations bundle (5-9), plus Omnichannel Retargeting & Display and Unified Social
--     Analytics & Scheduler.
--   Tenant 4 (NorthStar Solutions, 3 modules)  — no per-module record exists; reconstructed as
--     Funnel & Site Builder, Commission & Split Tracker, Connected TV & OTT Ad Network, whose
--     resale total (~$894 at 25% markup) matches the tenant's $890 MRR.
--
-- Idempotent: safe to re-run (ON CONFLICT DO NOTHING + final reconciliation).

BEGIN;

INSERT INTO tenant_modules (tenant_id, module_id, provisioned_at)
SELECT v.tenant_id, v.module_id, v.provisioned_at::timestamp
FROM (VALUES
  -- Tenant 1: exact list from activity log
  (1, 1,  '2026-06-25 10:05:06'), (1, 6,  '2026-06-25 10:05:06'),
  (1, 4,  '2026-06-25 10:05:06'), (1, 5,  '2026-06-25 10:05:06'),
  (1, 16, '2026-06-25 10:05:06'), (1, 19, '2026-06-25 10:05:06'),
  (1, 20, '2026-06-25 10:05:06'),
  -- Tenant 2: reconstructed "full marketing and operations suite"
  (2, 1,  '2026-06-29 06:22:36'), (2, 2,  '2026-06-29 06:22:36'),
  (2, 3,  '2026-06-29 06:22:36'), (2, 4,  '2026-06-29 06:22:36'),
  (2, 5,  '2026-06-29 06:22:36'), (2, 6,  '2026-06-29 06:22:36'),
  (2, 7,  '2026-06-29 06:22:36'), (2, 8,  '2026-06-29 06:22:36'),
  (2, 9,  '2026-06-29 06:22:36'), (2, 17, '2026-06-29 06:22:36'),
  (2, 21, '2026-06-29 06:22:36'),
  -- Tenant 3: exact list from activity log
  (3, 2,  '2026-07-06 15:23:19'), (3, 7,  '2026-07-06 15:23:19'),
  (3, 8,  '2026-07-06 15:23:19'), (3, 18, '2026-07-06 15:23:19'),
  -- Tenant 4: reconstructed (no per-module record; resale total matches MRR)
  (4, 3,  '2026-07-13 23:36:43'), (4, 8,  '2026-07-13 23:36:43'),
  (4, 16, '2026-07-13 23:36:43')
) AS v(tenant_id, module_id, provisioned_at)
ON CONFLICT (tenant_id, module_id) DO NOTHING;

-- Audit trail: record the backfill for each affected tenant (only once).
INSERT INTO tenant_activities (tenant_id, action, details)
SELECT t.id, 'Module records backfilled',
       'Historical module assignments backfilled into per-module tracking (' || t.modules_enabled || ' module(s))'
FROM tenants t
WHERE t.modules_enabled > 0
  AND NOT EXISTS (
    SELECT 1 FROM tenant_activities a
    WHERE a.tenant_id = t.id AND a.action = 'Module records backfilled'
  );

-- Reconcile: tenants.modules_enabled must equal the join-table count for every tenant.
UPDATE tenants t
SET modules_enabled = c.cnt
FROM (
  SELECT t2.id, COUNT(tm.id) AS cnt
  FROM tenants t2 LEFT JOIN tenant_modules tm ON tm.tenant_id = t2.id
  GROUP BY t2.id
) c
WHERE c.id = t.id AND t.modules_enabled <> c.cnt;

COMMIT;
