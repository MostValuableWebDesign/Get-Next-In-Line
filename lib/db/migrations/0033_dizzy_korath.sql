CREATE TABLE "perk_passes" (
	"id" serial PRIMARY KEY NOT NULL,
	"partnership_id" integer NOT NULL,
	"customer_phone" text NOT NULL,
	"customer_name" text,
	"granted_by_tenant_id" integer,
	"token" text NOT NULL,
	"granted_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"redeemed_at" timestamp,
	"redeemed_by_tenant_id" integer,
	"reminder_sent_at" timestamp,
	CONSTRAINT "perk_passes_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "wallet_login_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"code" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"phone" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "perk_passes" ADD CONSTRAINT "perk_passes_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "perk_passes" ADD CONSTRAINT "perk_passes_granted_by_tenant_id_tenants_id_fk" FOREIGN KEY ("granted_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "perk_passes" ADD CONSTRAINT "perk_passes_redeemed_by_tenant_id_tenants_id_fk" FOREIGN KEY ("redeemed_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "perk_passes_phone_idx" ON "perk_passes" USING btree ("customer_phone");--> statement-breakpoint
CREATE INDEX "perk_passes_partnership_phone_idx" ON "perk_passes" USING btree ("partnership_id","customer_phone");--> statement-breakpoint
CREATE INDEX "perk_passes_expires_idx" ON "perk_passes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "wallet_login_codes_phone_idx" ON "wallet_login_codes" USING btree ("phone","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wallet_sessions_phone_idx" ON "wallet_sessions" USING btree ("phone");