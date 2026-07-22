ALTER TABLE "sos_settings" ADD COLUMN "tenant_id" integer;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD CONSTRAINT "sos_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD CONSTRAINT "sos_settings_tenant_id_unique" UNIQUE("tenant_id");