ALTER TABLE "campaigns" DROP CONSTRAINT IF EXISTS "campaigns_code_unique";--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" DROP CONSTRAINT IF EXISTS "merchant_coop_partnerships_redemption_code_unique";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_code_idx" ON "campaigns" USING btree ("code");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_code_uq" UNIQUE("tenant_id","code");--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD CONSTRAINT "merchant_coop_partnerships_host_code_uq" UNIQUE("host_tenant_id","redemption_code");