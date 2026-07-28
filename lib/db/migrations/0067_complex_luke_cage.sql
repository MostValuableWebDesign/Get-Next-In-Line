CREATE TABLE "coop_obligation_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"debtor_tenant_id" integer NOT NULL,
	"creditor_tenant_id" integer NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"source_ref" text NOT NULL,
	"partnership_id" integer,
	"description" text,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"settlement_cycle_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_obligation_ledger_kind_source_ref_uq" UNIQUE("kind","source_ref")
);
--> statement-breakpoint
CREATE TABLE "coop_settlement_cycles" (
	"id" serial PRIMARY KEY NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"status" text DEFAULT 'closed' NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"gross_volume" numeric(12, 2) DEFAULT '0' NOT NULL,
	"executed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_settlement_statements" (
	"id" serial PRIMARY KEY NOT NULL,
	"cycle_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"total_owed_to_others" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_owed_by_others" numeric(12, 2) DEFAULT '0' NOT NULL,
	"net_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_settlement_statements_cycle_tenant_uq" UNIQUE("cycle_id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "coop_obligation_ledger" ADD CONSTRAINT "coop_obligation_ledger_debtor_tenant_id_tenants_id_fk" FOREIGN KEY ("debtor_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_obligation_ledger" ADD CONSTRAINT "coop_obligation_ledger_creditor_tenant_id_tenants_id_fk" FOREIGN KEY ("creditor_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_obligation_ledger" ADD CONSTRAINT "coop_obligation_ledger_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_obligation_ledger" ADD CONSTRAINT "coop_obligation_ledger_settlement_cycle_id_coop_settlement_cycles_id_fk" FOREIGN KEY ("settlement_cycle_id") REFERENCES "public"."coop_settlement_cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_settlement_statements" ADD CONSTRAINT "coop_settlement_statements_cycle_id_coop_settlement_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."coop_settlement_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_settlement_statements" ADD CONSTRAINT "coop_settlement_statements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_obligation_ledger_cycle_occurred_idx" ON "coop_obligation_ledger" USING btree ("settlement_cycle_id","occurred_at");--> statement-breakpoint
CREATE INDEX "coop_obligation_ledger_debtor_idx" ON "coop_obligation_ledger" USING btree ("debtor_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_obligation_ledger_creditor_idx" ON "coop_obligation_ledger" USING btree ("creditor_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_settlement_cycles_executed_idx" ON "coop_settlement_cycles" USING btree ("executed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "coop_settlement_statements_tenant_idx" ON "coop_settlement_statements" USING btree ("tenant_id");