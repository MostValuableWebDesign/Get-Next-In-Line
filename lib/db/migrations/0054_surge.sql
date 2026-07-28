CREATE TABLE "coop_surge_activations" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"partnership_id" integer NOT NULL,
	"owner_tenant_id" integer NOT NULL,
	"base_discount_percent" integer NOT NULL,
	"boosted_discount_percent" integer NOT NULL,
	"trigger_reason" text NOT NULL,
	"activated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"end_reason" text
);
--> statement-breakpoint
CREATE TABLE "coop_surge_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"partnership_id" integer NOT NULL,
	"owner_tenant_id" integer NOT NULL,
	"trigger_type" text NOT NULL,
	"wait_threshold_minutes" integer,
	"base_discount_percent" integer NOT NULL,
	"boosted_discount_percent" integer NOT NULL,
	"boost_duration_minutes" integer DEFAULT 120 NOT NULL,
	"window_start_hour" integer,
	"window_end_hour" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "capacity_threshold" integer;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "capacity_status_override" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "capacity_override_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "coop_surge_activations" ADD CONSTRAINT "coop_surge_activations_rule_id_coop_surge_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."coop_surge_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_surge_activations" ADD CONSTRAINT "coop_surge_activations_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_surge_activations" ADD CONSTRAINT "coop_surge_activations_owner_tenant_id_tenants_id_fk" FOREIGN KEY ("owner_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_surge_rules" ADD CONSTRAINT "coop_surge_rules_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_surge_rules" ADD CONSTRAINT "coop_surge_rules_owner_tenant_id_tenants_id_fk" FOREIGN KEY ("owner_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_surge_activations_owner_idx" ON "coop_surge_activations" USING btree ("owner_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_surge_activations_partnership_idx" ON "coop_surge_activations" USING btree ("partnership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coop_surge_activations_one_live_per_rule_idx" ON "coop_surge_activations" USING btree ("rule_id") WHERE ended_at is null;--> statement-breakpoint
CREATE INDEX "coop_surge_rules_owner_idx" ON "coop_surge_rules" USING btree ("owner_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_surge_rules_partnership_idx" ON "coop_surge_rules" USING btree ("partnership_id");