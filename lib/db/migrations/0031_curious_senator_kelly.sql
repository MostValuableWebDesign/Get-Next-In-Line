CREATE TABLE "coop_perk_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"partnership_id" integer NOT NULL,
	"pass_code" text NOT NULL,
	"redeemed_by_tenant_id" integer,
	"redeemed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_perk_redemptions_partnership_pass_uq" UNIQUE("partnership_id","pass_code")
);
--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "perk_starts_at" timestamp;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "perk_ends_at" timestamp;--> statement-breakpoint
ALTER TABLE "coop_perk_redemptions" ADD CONSTRAINT "coop_perk_redemptions_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_perk_redemptions" ADD CONSTRAINT "coop_perk_redemptions_redeemed_by_tenant_id_tenants_id_fk" FOREIGN KEY ("redeemed_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;