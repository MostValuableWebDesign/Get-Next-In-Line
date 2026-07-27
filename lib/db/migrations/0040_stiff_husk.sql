CREATE TABLE "platform_ledger_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"tenant_id" integer,
	"category" text NOT NULL,
	"description" text,
	"amount" numeric(12, 2) NOT NULL,
	"wholesale_amount" numeric(12, 2),
	"platform_margin" numeric(12, 2) DEFAULT '0' NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "platform_ledger_source_ref_uq" UNIQUE("source","source_ref")
);
--> statement-breakpoint
ALTER TABLE "platform_ledger_entries" ADD CONSTRAINT "platform_ledger_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_ledger_occurred_idx" ON "platform_ledger_entries" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "platform_ledger_tenant_idx" ON "platform_ledger_entries" USING btree ("tenant_id");--> statement-breakpoint
-- Append-only guard: block every UPDATE/DELETE except the tenant FK's
-- ON DELETE SET NULL detach (tenant_id -> NULL with all other columns unchanged).
CREATE OR REPLACE FUNCTION platform_ledger_entries_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.tenant_id IS NOT NULL
     AND NEW.tenant_id IS NULL
     AND NEW.id = OLD.id
     AND NEW.source = OLD.source
     AND NEW.source_ref = OLD.source_ref
     AND NEW.category = OLD.category
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW.amount = OLD.amount
     AND NEW.wholesale_amount IS NOT DISTINCT FROM OLD.wholesale_amount
     AND NEW.platform_margin = OLD.platform_margin
     AND NEW.occurred_at = OLD.occurred_at
     AND NEW.recorded_at = OLD.recorded_at
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'platform_ledger_entries is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER platform_ledger_entries_no_mutation
  BEFORE UPDATE OR DELETE ON "platform_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION platform_ledger_entries_append_only();--> statement-breakpoint
INSERT INTO "platform_ledger_entries" (source, source_ref, tenant_id, category, description, amount, wholesale_amount, platform_margin, occurred_at)
SELECT
  'module_subscription',
  'tenant_modules:' || tm.id,
  tm.tenant_id,
  m.category,
  m.name || ' (' || tm.billing_cadence || ')',
  ROUND(COALESCE(tm.charged_resale, w.wholesale * (1 + w.eff_markup / 100)), 2),
  ROUND(COALESCE(tm.charged_wholesale, w.wholesale), 2),
  ROUND(COALESCE(tm.charged_resale, w.wholesale * (1 + w.eff_markup / 100)) - COALESCE(tm.charged_wholesale, w.wholesale), 2),
  tm.provisioned_at
FROM tenant_modules tm
JOIN modules m ON m.id = tm.module_id
CROSS JOIN LATERAL (
  SELECT
    CASE WHEN tm.billing_cadence = 'biweekly' AND m.wholesale_price_biweekly IS NOT NULL
         THEN m.wholesale_price_biweekly ELSE m.wholesale_price END AS wholesale,
    CASE WHEN m.category_slug = 'partners' THEN 0
         WHEN m.markup_percent_override IS NOT NULL THEN m.markup_percent_override
         ELSE COALESCE((SELECT markup_percent FROM agency_settings LIMIT 1), 25) END AS eff_markup
) w
ON CONFLICT (source, source_ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "platform_ledger_entries" (source, source_ref, tenant_id, category, description, amount, platform_margin, occurred_at)
SELECT
  'visit_checkout',
  'sos_visits:' || v.id,
  v.tenant_id,
  'Visits',
  'Visit checkout — ' || v.service_type,
  v.payment_amount,
  0,
  COALESCE(v.checked_out_at, v.checked_in_at)
FROM sos_visits v
WHERE v.status = 'checked_out' AND v.payment_amount IS NOT NULL
ON CONFLICT (source, source_ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "platform_ledger_entries" (source, source_ref, tenant_id, category, description, amount, platform_margin, occurred_at)
SELECT
  CASE pt.transaction_type WHEN 'purchase' THEN 'plan_purchase' ELSE 'plan_renewal' END,
  'sos_plan_transactions:' || pt.id,
  c.tenant_id,
  'Plans',
  COALESCE(pt.note, 'Plan ' || pt.transaction_type),
  pt.amount,
  0,
  pt.created_at
FROM sos_plan_transactions pt
JOIN sos_customers c ON c.id = pt.customer_id
WHERE pt.transaction_type IN ('purchase', 'renewal') AND pt.amount IS NOT NULL
ON CONFLICT (source, source_ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "platform_ledger_entries" (source, source_ref, tenant_id, category, description, amount, platform_margin, occurred_at)
SELECT
  CASE h.status WHEN 'captured' THEN 'deposit_captured' WHEN 'released' THEN 'deposit_released' ELSE 'deposit_failed' END,
  'sos_deposit_holds:' || h.id,
  a.tenant_id,
  'Deposits',
  h.outcome_reason,
  CASE WHEN h.status = 'captured' THEN h.fee_amount ELSE 0 END,
  0,
  COALESCE(h.resolved_at, h.created_at)
FROM sos_deposit_holds h
JOIN sos_appointments a ON a.id = h.appointment_id
WHERE h.status IN ('captured', 'released', 'failed')
ON CONFLICT (source, source_ref) DO NOTHING;
