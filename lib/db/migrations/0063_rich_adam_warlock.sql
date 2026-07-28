CREATE TABLE "sos_gratuity_ledger_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"visit_id" integer NOT NULL,
	"source_tenant_id" integer,
	"recipient_tenant_id" integer,
	"recipient_staff_id" integer NOT NULL,
	"gross_tip" numeric(10, 2) NOT NULL,
	"allocated_share" numeric(10, 2) NOT NULL,
	"rule_id" integer,
	"rule_snapshot" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sos_tip_pool_rule_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"tenant_id" integer,
	"staff_id" integer NOT NULL,
	"role" text,
	"percent" integer,
	"weight" integer
);
--> statement-breakpoint
CREATE TABLE "sos_tip_pool_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer,
	"scope" text NOT NULL,
	"partnership_id" integer,
	"split_method" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sos_visit_bundles" (
	"id" serial PRIMARY KEY NOT NULL,
	"partnership_id" integer NOT NULL,
	"created_by_tenant_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sos_visits" ADD COLUMN "bundle_id" integer;--> statement-breakpoint
ALTER TABLE "sos_gratuity_ledger_entries" ADD CONSTRAINT "sos_gratuity_ledger_entries_visit_id_sos_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."sos_visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_gratuity_ledger_entries" ADD CONSTRAINT "sos_gratuity_ledger_entries_source_tenant_id_tenants_id_fk" FOREIGN KEY ("source_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_gratuity_ledger_entries" ADD CONSTRAINT "sos_gratuity_ledger_entries_recipient_tenant_id_tenants_id_fk" FOREIGN KEY ("recipient_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_gratuity_ledger_entries" ADD CONSTRAINT "sos_gratuity_ledger_entries_recipient_staff_id_sos_staff_members_id_fk" FOREIGN KEY ("recipient_staff_id") REFERENCES "public"."sos_staff_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_gratuity_ledger_entries" ADD CONSTRAINT "sos_gratuity_ledger_entries_rule_id_sos_tip_pool_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."sos_tip_pool_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_tip_pool_rule_participants" ADD CONSTRAINT "sos_tip_pool_rule_participants_rule_id_sos_tip_pool_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."sos_tip_pool_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_tip_pool_rule_participants" ADD CONSTRAINT "sos_tip_pool_rule_participants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_tip_pool_rule_participants" ADD CONSTRAINT "sos_tip_pool_rule_participants_staff_id_sos_staff_members_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."sos_staff_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_tip_pool_rules" ADD CONSTRAINT "sos_tip_pool_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_tip_pool_rules" ADD CONSTRAINT "sos_tip_pool_rules_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_visit_bundles" ADD CONSTRAINT "sos_visit_bundles_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_visit_bundles" ADD CONSTRAINT "sos_visit_bundles_created_by_tenant_id_tenants_id_fk" FOREIGN KEY ("created_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sos_gratuity_ledger_visit_idx" ON "sos_gratuity_ledger_entries" USING btree ("visit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sos_gratuity_ledger_visit_recipient_uniq" ON "sos_gratuity_ledger_entries" USING btree ("visit_id","recipient_staff_id");--> statement-breakpoint
CREATE INDEX "sos_gratuity_ledger_recipient_tenant_created_idx" ON "sos_gratuity_ledger_entries" USING btree ("recipient_tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sos_gratuity_ledger_recipient_staff_idx" ON "sos_gratuity_ledger_entries" USING btree ("recipient_staff_id");--> statement-breakpoint
CREATE INDEX "sos_tip_pool_rule_participants_rule_idx" ON "sos_tip_pool_rule_participants" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "sos_tip_pool_rules_tenant_idx" ON "sos_tip_pool_rules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sos_tip_pool_rules_partnership_idx" ON "sos_tip_pool_rules" USING btree ("partnership_id");--> statement-breakpoint
CREATE INDEX "sos_visit_bundles_partnership_idx" ON "sos_visit_bundles" USING btree ("partnership_id");--> statement-breakpoint
ALTER TABLE "sos_visits" ADD CONSTRAINT "sos_visits_bundle_id_sos_visit_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."sos_visit_bundles"("id") ON DELETE set null ON UPDATE no action;