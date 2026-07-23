ALTER TABLE "sos_plans" ADD COLUMN "tenant_id" integer;--> statement-breakpoint
ALTER TABLE "sos_plans" ADD CONSTRAINT "sos_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sos_plans_tenant_id_idx" ON "sos_plans" USING btree ("tenant_id");