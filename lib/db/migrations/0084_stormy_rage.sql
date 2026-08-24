CREATE TABLE "sos_sms_consent_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"customer_id" integer NOT NULL,
	"phone" text NOT NULL,
	"source" text NOT NULL,
	"disclosure_version" text NOT NULL,
	"disclosure_text" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"consented_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sos_sms_consent_records" ADD CONSTRAINT "sos_sms_consent_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_sms_consent_records" ADD CONSTRAINT "sos_sms_consent_records_customer_id_sos_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."sos_customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sos_sms_consent_records_tenant_id_idx" ON "sos_sms_consent_records" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sos_sms_consent_records_customer_id_idx" ON "sos_sms_consent_records" USING btree ("customer_id");