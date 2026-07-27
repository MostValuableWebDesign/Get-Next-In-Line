CREATE TABLE "coop_tier_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"partnership_id" integer NOT NULL,
	"previous_state" text NOT NULL,
	"new_state" text NOT NULL,
	"reason" text NOT NULL,
	"host_to_partner_count" integer DEFAULT 0 NOT NULL,
	"partner_to_host_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "tier" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "host_reciprocity_threshold" integer;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "partner_reciprocity_threshold" integer;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "performance_paused_at" timestamp;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "reactivation_requested_by_tenant_id" integer;--> statement-breakpoint
ALTER TABLE "coop_tier_events" ADD CONSTRAINT "coop_tier_events_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_tier_events_partnership_idx" ON "coop_tier_events" USING btree ("partnership_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD CONSTRAINT "merchant_coop_partnerships_reactivation_requested_by_tenant_id_tenants_id_fk" FOREIGN KEY ("reactivation_requested_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;