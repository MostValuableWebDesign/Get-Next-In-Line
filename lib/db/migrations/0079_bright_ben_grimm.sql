CREATE TABLE "coop_settlement_payouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"cycle_id" integer NOT NULL,
	"statement_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"mode" text DEFAULT 'simulated' NOT NULL,
	"provider_ref" text,
	"destination" text,
	"failure_reason" text,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_settlement_payouts_statement_uq" UNIQUE("statement_id")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "payout_stripe_account_id" text;--> statement-breakpoint
ALTER TABLE "coop_settlement_payouts" ADD CONSTRAINT "coop_settlement_payouts_cycle_id_coop_settlement_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."coop_settlement_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_settlement_payouts" ADD CONSTRAINT "coop_settlement_payouts_statement_id_coop_settlement_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."coop_settlement_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_settlement_payouts" ADD CONSTRAINT "coop_settlement_payouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_settlement_payouts_cycle_idx" ON "coop_settlement_payouts" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "coop_settlement_payouts_tenant_idx" ON "coop_settlement_payouts" USING btree ("tenant_id");