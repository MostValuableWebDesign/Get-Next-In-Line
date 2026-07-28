CREATE TABLE "coop_financial_dispute_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"dispute_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_tenant_id" integer,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_financial_dispute_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"dispute_id" integer NOT NULL,
	"added_by_tenant_id" integer,
	"kind" text NOT NULL,
	"redemption_id" integer,
	"reference_number" text,
	"amount" numeric(12, 2),
	"entry_date" timestamp,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_financial_disputes" (
	"id" serial PRIMARY KEY NOT NULL,
	"partnership_id" integer NOT NULL,
	"filed_by_tenant_id" integer NOT NULL,
	"respondent_tenant_id" integer NOT NULL,
	"dispute_type" text NOT NULL,
	"claimed_count" integer,
	"expected_count" integer,
	"claimed_amount" numeric(12, 2),
	"expected_amount" numeric(12, 2),
	"window_start_at" timestamp NOT NULL,
	"window_end_at" timestamp NOT NULL,
	"details" text,
	"status" text DEFAULT 'filed' NOT NULL,
	"reconciliation_summary" text,
	"reconciliation_system_count" integer,
	"counterparty_response" text,
	"responded_at" timestamp,
	"ruling" text,
	"ruled_against_tenant_id" integer,
	"escalated_at" timestamp,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_ledger_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"dispute_id" integer NOT NULL,
	"partnership_id" integer NOT NULL,
	"adjustment_type" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"credit_tenant_id" integer,
	"debit_tenant_id" integer,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_tenant_suspensions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"trigger" text NOT NULL,
	"reason" text,
	"rulings_count" integer,
	"window_days" integer,
	"suspended_at" timestamp DEFAULT now() NOT NULL,
	"lifted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coop_financial_dispute_events" ADD CONSTRAINT "coop_financial_dispute_events_dispute_id_coop_financial_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."coop_financial_disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_financial_dispute_events" ADD CONSTRAINT "coop_financial_dispute_events_actor_tenant_id_tenants_id_fk" FOREIGN KEY ("actor_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_financial_dispute_evidence" ADD CONSTRAINT "coop_financial_dispute_evidence_dispute_id_coop_financial_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."coop_financial_disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_financial_dispute_evidence" ADD CONSTRAINT "coop_financial_dispute_evidence_added_by_tenant_id_tenants_id_fk" FOREIGN KEY ("added_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_financial_dispute_evidence" ADD CONSTRAINT "coop_financial_dispute_evidence_redemption_id_coop_perk_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."coop_perk_redemptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_financial_disputes" ADD CONSTRAINT "coop_financial_disputes_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_financial_disputes" ADD CONSTRAINT "coop_financial_disputes_filed_by_tenant_id_tenants_id_fk" FOREIGN KEY ("filed_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_financial_disputes" ADD CONSTRAINT "coop_financial_disputes_respondent_tenant_id_tenants_id_fk" FOREIGN KEY ("respondent_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_financial_disputes" ADD CONSTRAINT "coop_financial_disputes_ruled_against_tenant_id_tenants_id_fk" FOREIGN KEY ("ruled_against_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_ledger_adjustments" ADD CONSTRAINT "coop_ledger_adjustments_dispute_id_coop_financial_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."coop_financial_disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_ledger_adjustments" ADD CONSTRAINT "coop_ledger_adjustments_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_ledger_adjustments" ADD CONSTRAINT "coop_ledger_adjustments_credit_tenant_id_tenants_id_fk" FOREIGN KEY ("credit_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_ledger_adjustments" ADD CONSTRAINT "coop_ledger_adjustments_debit_tenant_id_tenants_id_fk" FOREIGN KEY ("debit_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_tenant_suspensions" ADD CONSTRAINT "coop_tenant_suspensions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_financial_dispute_events_dispute_idx" ON "coop_financial_dispute_events" USING btree ("dispute_id","created_at");--> statement-breakpoint
CREATE INDEX "coop_financial_dispute_evidence_dispute_idx" ON "coop_financial_dispute_evidence" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "coop_financial_disputes_partnership_idx" ON "coop_financial_disputes" USING btree ("partnership_id");--> statement-breakpoint
CREATE INDEX "coop_financial_disputes_status_idx" ON "coop_financial_disputes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "coop_financial_disputes_filed_by_idx" ON "coop_financial_disputes" USING btree ("filed_by_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_financial_disputes_ruled_against_idx" ON "coop_financial_disputes" USING btree ("ruled_against_tenant_id","resolved_at");--> statement-breakpoint
CREATE INDEX "coop_ledger_adjustments_dispute_idx" ON "coop_ledger_adjustments" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "coop_tenant_suspensions_tenant_idx" ON "coop_tenant_suspensions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coop_tenant_suspensions_one_active_idx" ON "coop_tenant_suspensions" USING btree ("tenant_id") WHERE status = 'active';