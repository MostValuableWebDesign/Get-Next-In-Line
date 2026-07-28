CREATE TABLE "coop_featured_boosts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"partnership_id" integer NOT NULL,
	"surface" text NOT NULL,
	"pricing_type" text NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_wallet_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"entry_type" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"fee" numeric(12, 2) DEFAULT '0' NOT NULL,
	"partnership_id" integer,
	"redemption_id" integer,
	"boost_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agency_settings" ADD COLUMN "coop_platform_fee_percent" numeric(5, 2) DEFAULT '10' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "revenue_share_kind" text;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "revenue_share_value" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "revenue_share_base_amount" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "coop_featured_boosts" ADD CONSTRAINT "coop_featured_boosts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_featured_boosts" ADD CONSTRAINT "coop_featured_boosts_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_wallet_entries" ADD CONSTRAINT "coop_wallet_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_wallet_entries" ADD CONSTRAINT "coop_wallet_entries_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_wallet_entries" ADD CONSTRAINT "coop_wallet_entries_redemption_id_coop_perk_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."coop_perk_redemptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_wallet_entries" ADD CONSTRAINT "coop_wallet_entries_boost_id_coop_featured_boosts_id_fk" FOREIGN KEY ("boost_id") REFERENCES "public"."coop_featured_boosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_featured_boosts_surface_status_idx" ON "coop_featured_boosts" USING btree ("surface","status");--> statement-breakpoint
CREATE INDEX "coop_featured_boosts_tenant_idx" ON "coop_featured_boosts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "coop_featured_boosts_partnership_idx" ON "coop_featured_boosts" USING btree ("partnership_id");--> statement-breakpoint
CREATE INDEX "coop_wallet_entries_tenant_idx" ON "coop_wallet_entries" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "coop_wallet_entries_status_idx" ON "coop_wallet_entries" USING btree ("tenant_id","status");