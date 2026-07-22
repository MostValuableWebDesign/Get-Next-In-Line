ALTER TABLE "sos_appointments" ADD COLUMN "tenant_id" integer;--> statement-breakpoint
ALTER TABLE "sos_calls" ADD COLUMN "tenant_id" integer;--> statement-breakpoint
ALTER TABLE "sos_customers" ADD COLUMN "tenant_id" integer;--> statement-breakpoint
ALTER TABLE "sos_resources" ADD COLUMN "tenant_id" integer;--> statement-breakpoint
ALTER TABLE "sos_visits" ADD COLUMN "tenant_id" integer;--> statement-breakpoint
ALTER TABLE "sos_waitlist_entries" ADD COLUMN "tenant_id" integer;--> statement-breakpoint
ALTER TABLE "sos_appointments" ADD CONSTRAINT "sos_appointments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_calls" ADD CONSTRAINT "sos_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_customers" ADD CONSTRAINT "sos_customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_resources" ADD CONSTRAINT "sos_resources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_visits" ADD CONSTRAINT "sos_visits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_waitlist_entries" ADD CONSTRAINT "sos_waitlist_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sos_appointments_tenant_id_idx" ON "sos_appointments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sos_calls_tenant_id_idx" ON "sos_calls" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sos_customers_tenant_id_idx" ON "sos_customers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sos_resources_tenant_id_idx" ON "sos_resources" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sos_visits_tenant_id_idx" ON "sos_visits" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sos_waitlist_entries_tenant_id_idx" ON "sos_waitlist_entries" USING btree ("tenant_id");