CREATE TABLE "sos_gratuity_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer,
	"visit_id" integer NOT NULL,
	"staff_id" integer NOT NULL,
	"rule_applied" text NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "tip_split_rule" text DEFAULT 'equal' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_staff_members" ADD COLUMN "tip_percent" integer;--> statement-breakpoint
ALTER TABLE "sos_staff_members" ADD COLUMN "tip_role_weight" integer;--> statement-breakpoint
ALTER TABLE "sos_visits" ADD COLUMN "tip_amount" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "sos_gratuity_ledger" ADD CONSTRAINT "sos_gratuity_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_gratuity_ledger" ADD CONSTRAINT "sos_gratuity_ledger_visit_id_sos_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."sos_visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_gratuity_ledger" ADD CONSTRAINT "sos_gratuity_ledger_staff_id_sos_staff_members_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."sos_staff_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sos_gratuity_ledger_tenant_id_idx" ON "sos_gratuity_ledger" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sos_gratuity_ledger_staff_created_idx" ON "sos_gratuity_ledger" USING btree ("staff_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sos_gratuity_ledger_visit_id_idx" ON "sos_gratuity_ledger" USING btree ("visit_id");