CREATE TABLE "safety_broadcast_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"title" text NOT NULL,
	"incident_type" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safety_defaults_seeded" (
	"tenant_id" integer PRIMARY KEY NOT NULL,
	"seeded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safety_emergency_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"label" text NOT NULL,
	"phone" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safety_incident_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"incident_id" integer NOT NULL,
	"actor_tenant_id" integer NOT NULL,
	"kind" text NOT NULL,
	"body" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safety_incident_recipients" (
	"id" serial PRIMARY KEY NOT NULL,
	"incident_id" integer NOT NULL,
	"recipient_tenant_id" integer NOT NULL,
	"acknowledged_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "safety_incident_recipients_unique" UNIQUE("incident_id","recipient_tenant_id")
);
--> statement-breakpoint
CREATE TABLE "safety_incidents" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"incident_type" text NOT NULL,
	"description" text NOT NULL,
	"location" text,
	"status" text DEFAULT 'active' NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "safety_broadcast_templates" ADD CONSTRAINT "safety_broadcast_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_defaults_seeded" ADD CONSTRAINT "safety_defaults_seeded_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_emergency_contacts" ADD CONSTRAINT "safety_emergency_contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_incident_events" ADD CONSTRAINT "safety_incident_events_incident_id_safety_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."safety_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_incident_events" ADD CONSTRAINT "safety_incident_events_actor_tenant_id_tenants_id_fk" FOREIGN KEY ("actor_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_incident_recipients" ADD CONSTRAINT "safety_incident_recipients_incident_id_safety_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."safety_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_incident_recipients" ADD CONSTRAINT "safety_incident_recipients_recipient_tenant_id_tenants_id_fk" FOREIGN KEY ("recipient_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "safety_broadcast_templates_tenant_idx" ON "safety_broadcast_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "safety_emergency_contacts_tenant_idx" ON "safety_emergency_contacts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "safety_incident_events_incident_idx" ON "safety_incident_events" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "safety_incident_recipients_tenant_idx" ON "safety_incident_recipients" USING btree ("recipient_tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "safety_incidents_tenant_idx" ON "safety_incidents" USING btree ("tenant_id","created_at" DESC NULLS LAST);