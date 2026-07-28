CREATE TABLE "coop_offline_sync_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_redemption_id" text NOT NULL,
	"tenant_id" integer,
	"partnership_id" integer,
	"pass_code" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"winning_redemption_id" integer,
	"scanned_at" timestamp,
	"synced_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_offline_sync_audit_client_redemption_id_unique" UNIQUE("client_redemption_id")
);
--> statement-breakpoint
CREATE TABLE "coop_signing_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"public_key_pem" text NOT NULL,
	"private_key_pem" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"retired_at" timestamp,
	CONSTRAINT "coop_signing_keys_key_id_unique" UNIQUE("key_id")
);
--> statement-breakpoint
ALTER TABLE "coop_perk_redemptions" ADD COLUMN "client_redemption_id" text;--> statement-breakpoint
ALTER TABLE "coop_offline_sync_audit" ADD CONSTRAINT "coop_offline_sync_audit_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_offline_sync_audit" ADD CONSTRAINT "coop_offline_sync_audit_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_offline_sync_audit" ADD CONSTRAINT "coop_offline_sync_audit_winning_redemption_id_coop_perk_redemptions_id_fk" FOREIGN KEY ("winning_redemption_id") REFERENCES "public"."coop_perk_redemptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_offline_sync_audit_tenant_idx" ON "coop_offline_sync_audit" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "coop_signing_keys_status_idx" ON "coop_signing_keys" USING btree ("status");--> statement-breakpoint
ALTER TABLE "coop_perk_redemptions" ADD CONSTRAINT "coop_perk_redemptions_client_redemption_id_unique" UNIQUE("client_redemption_id");