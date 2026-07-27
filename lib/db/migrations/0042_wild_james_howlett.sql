CREATE TABLE "pos_inbound_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"integration_id" integer NOT NULL,
	"tenant_id" integer,
	"vendor" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_kind" text NOT NULL,
	"status" text NOT NULL,
	"payload" text NOT NULL,
	"detail" text,
	"customer_id" integer,
	"visit_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pos_inbound_events_integration_external_unique" UNIQUE("integration_id","external_event_id")
);
--> statement-breakpoint
CREATE TABLE "pos_integrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer,
	"vendor" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"webhook_token" text NOT NULL,
	"signing_secret_encrypted" text NOT NULL,
	"last_event_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pos_integrations_webhook_token_unique" UNIQUE("webhook_token"),
	CONSTRAINT "pos_integrations_tenant_vendor_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","vendor")
);
--> statement-breakpoint
ALTER TABLE "pos_inbound_events" ADD CONSTRAINT "pos_inbound_events_integration_id_pos_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."pos_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_inbound_events" ADD CONSTRAINT "pos_inbound_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_inbound_events" ADD CONSTRAINT "pos_inbound_events_customer_id_sos_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."sos_customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_inbound_events" ADD CONSTRAINT "pos_inbound_events_visit_id_sos_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."sos_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_integrations" ADD CONSTRAINT "pos_integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pos_inbound_events_integration_created_idx" ON "pos_inbound_events" USING btree ("integration_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);