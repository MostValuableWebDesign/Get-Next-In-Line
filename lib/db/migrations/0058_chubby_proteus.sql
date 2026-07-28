CREATE TABLE "coop_compliance_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer,
	"category" text NOT NULL,
	"direction" text NOT NULL,
	"counterpart_tenant_id" integer,
	"payee_name" text,
	"description" text,
	"gross_amount" numeric(12, 2) NOT NULL,
	"state_rate_percent" numeric(5, 2) NOT NULL,
	"local_rate_percent" numeric(5, 2) NOT NULL,
	"sales_rate_percent" numeric(5, 2) NOT NULL,
	"estimated_tax_amount" numeric(12, 2) NOT NULL,
	"source_ref" text NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_compliance_ledger_source_ref_unique" UNIQUE("source_ref")
);
--> statement-breakpoint
CREATE TABLE "coop_partner_payouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer,
	"payee_key" text NOT NULL,
	"payee_name" text NOT NULL,
	"calendar_year" integer NOT NULL,
	"total_paid" numeric(12, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_partner_payouts_scope_uq" UNIQUE("tenant_id","payee_key","calendar_year")
);
--> statement-breakpoint
CREATE TABLE "coop_tax_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer,
	"state_rate_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"local_rate_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"sales_rate_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"threshold_1099" numeric(10, 2) DEFAULT '600' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_tax_settings_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "perk_value_amount" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "coop_compliance_ledger" ADD CONSTRAINT "coop_compliance_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_compliance_ledger" ADD CONSTRAINT "coop_compliance_ledger_counterpart_tenant_id_tenants_id_fk" FOREIGN KEY ("counterpart_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_partner_payouts" ADD CONSTRAINT "coop_partner_payouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_tax_settings" ADD CONSTRAINT "coop_tax_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_compliance_ledger_tenant_occurred_idx" ON "coop_compliance_ledger" USING btree ("tenant_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "coop_partner_payouts_tenant_year_idx" ON "coop_partner_payouts" USING btree ("tenant_id","calendar_year");