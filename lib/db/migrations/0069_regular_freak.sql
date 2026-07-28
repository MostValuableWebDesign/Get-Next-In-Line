CREATE TABLE "ambassador_pool_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_type" text NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"tenant_id" integer,
	"identity_id" integer,
	"redemption_id" integer,
	"reward_id" integer,
	"referral_id" integer,
	"description" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ambassador_pool_entries_redemption_id_unique" UNIQUE("redemption_id"),
	CONSTRAINT "ambassador_pool_entries_reward_uq" UNIQUE("reward_id")
);
--> statement-breakpoint
CREATE TABLE "ambassador_program_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"opted_in" boolean DEFAULT false NOT NULL,
	"pledge_per_redemption" numeric(10, 2) DEFAULT '1.00' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ambassador_program_settings_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "ambassador_referral_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"identity_id" integer NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ambassador_referral_codes_identity_id_unique" UNIQUE("identity_id"),
	CONSTRAINT "ambassador_referral_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "ambassador_referrals" (
	"id" serial PRIMARY KEY NOT NULL,
	"referrer_identity_id" integer NOT NULL,
	"friend_identity_id" integer NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"converted_tenant_id" integer,
	"converted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ambassador_referrals_friend_identity_id_unique" UNIQUE("friend_identity_id")
);
--> statement-breakpoint
CREATE TABLE "ambassador_rewards" (
	"id" serial PRIMARY KEY NOT NULL,
	"identity_id" integer NOT NULL,
	"code" text NOT NULL,
	"source" text NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"referral_id" integer,
	"status" text DEFAULT 'issued' NOT NULL,
	"redeemed_by_tenant_id" integer,
	"redeemed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ambassador_rewards_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "ambassador_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"identity_id" integer NOT NULL,
	"tier" text DEFAULT 'member' NOT NULL,
	"distinct_partners" integer DEFAULT 0 NOT NULL,
	"converted_referrals" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ambassador_status_identity_id_unique" UNIQUE("identity_id")
);
--> statement-breakpoint
ALTER TABLE "ambassador_pool_entries" ADD CONSTRAINT "ambassador_pool_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassador_pool_entries" ADD CONSTRAINT "ambassador_pool_entries_identity_id_passport_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."passport_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassador_pool_entries" ADD CONSTRAINT "ambassador_pool_entries_redemption_id_coop_perk_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."coop_perk_redemptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassador_program_settings" ADD CONSTRAINT "ambassador_program_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassador_referral_codes" ADD CONSTRAINT "ambassador_referral_codes_identity_id_passport_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."passport_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassador_referrals" ADD CONSTRAINT "ambassador_referrals_referrer_identity_id_passport_identities_id_fk" FOREIGN KEY ("referrer_identity_id") REFERENCES "public"."passport_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassador_referrals" ADD CONSTRAINT "ambassador_referrals_friend_identity_id_passport_identities_id_fk" FOREIGN KEY ("friend_identity_id") REFERENCES "public"."passport_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassador_referrals" ADD CONSTRAINT "ambassador_referrals_converted_tenant_id_tenants_id_fk" FOREIGN KEY ("converted_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassador_rewards" ADD CONSTRAINT "ambassador_rewards_identity_id_passport_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."passport_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassador_rewards" ADD CONSTRAINT "ambassador_rewards_referral_id_ambassador_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."ambassador_referrals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassador_rewards" ADD CONSTRAINT "ambassador_rewards_redeemed_by_tenant_id_tenants_id_fk" FOREIGN KEY ("redeemed_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassador_status" ADD CONSTRAINT "ambassador_status_identity_id_passport_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."passport_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ambassador_pool_entries_tenant_idx" ON "ambassador_pool_entries" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ambassador_referrals_referrer_idx" ON "ambassador_referrals" USING btree ("referrer_identity_id");--> statement-breakpoint
CREATE INDEX "ambassador_rewards_identity_idx" ON "ambassador_rewards" USING btree ("identity_id");