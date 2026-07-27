ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "status" text DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "requested_by_tenant_id" integer;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "mutual_reward_terms" text;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "responded_at" timestamp;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD CONSTRAINT "merchant_coop_partnerships_requested_by_tenant_id_tenants_id_fk" FOREIGN KEY ("requested_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;