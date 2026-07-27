CREATE TABLE "passport_challenges" (
	"id" serial PRIMARY KEY NOT NULL,
	"sponsor_tenant_id" integer NOT NULL,
	"title" text NOT NULL,
	"required_businesses" integer NOT NULL,
	"window_days" integer NOT NULL,
	"reward_type" text NOT NULL,
	"reward_description" text NOT NULL,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passport_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text,
	"email" text,
	"display_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "passport_identities_phone_unique" UNIQUE("phone"),
	CONSTRAINT "passport_identities_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "passport_reward_issuances" (
	"id" serial PRIMARY KEY NOT NULL,
	"challenge_id" integer NOT NULL,
	"identity_id" integer NOT NULL,
	"reward_type" text NOT NULL,
	"reward_description" text NOT NULL,
	"stamp_count" integer NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "passport_reward_issuances_challenge_identity_uq" UNIQUE("challenge_id","identity_id")
);
--> statement-breakpoint
CREATE TABLE "passport_stamps" (
	"id" serial PRIMARY KEY NOT NULL,
	"identity_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"redemption_id" integer,
	"stamped_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "passport_stamps_identity_tenant_uq" UNIQUE("identity_id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "passport_challenges" ADD CONSTRAINT "passport_challenges_sponsor_tenant_id_tenants_id_fk" FOREIGN KEY ("sponsor_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passport_reward_issuances" ADD CONSTRAINT "passport_reward_issuances_challenge_id_passport_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."passport_challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passport_reward_issuances" ADD CONSTRAINT "passport_reward_issuances_identity_id_passport_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."passport_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passport_stamps" ADD CONSTRAINT "passport_stamps_identity_id_passport_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."passport_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passport_stamps" ADD CONSTRAINT "passport_stamps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passport_stamps" ADD CONSTRAINT "passport_stamps_redemption_id_coop_perk_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."coop_perk_redemptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passport_challenges_sponsor_idx" ON "passport_challenges" USING btree ("sponsor_tenant_id");--> statement-breakpoint
CREATE INDEX "passport_reward_issuances_identity_idx" ON "passport_reward_issuances" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "passport_stamps_identity_idx" ON "passport_stamps" USING btree ("identity_id");