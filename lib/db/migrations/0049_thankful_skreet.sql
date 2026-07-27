CREATE TABLE "coop_traffic_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"partnership_id" integer NOT NULL,
	"receiving_tenant_id" integer NOT NULL,
	"source_tenant_id" integer,
	"event_type" text NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "proposed_perk_title" text;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "proposed_perk_description" text;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "proposed_mutual_reward_terms" text;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "renegotiation_requested_by_tenant_id" integer;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "renegotiation_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "coop_reciprocity_margin_percent" integer;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "coop_reciprocity_window_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "coop_traffic_events" ADD CONSTRAINT "coop_traffic_events_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_traffic_events" ADD CONSTRAINT "coop_traffic_events_receiving_tenant_id_tenants_id_fk" FOREIGN KEY ("receiving_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_traffic_events" ADD CONSTRAINT "coop_traffic_events_source_tenant_id_tenants_id_fk" FOREIGN KEY ("source_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_traffic_events_partnership_occurred_idx" ON "coop_traffic_events" USING btree ("partnership_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "coop_traffic_events_receiving_tenant_idx" ON "coop_traffic_events" USING btree ("receiving_tenant_id");--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD CONSTRAINT "merchant_coop_partnerships_renegotiation_requested_by_tenant_id_tenants_id_fk" FOREIGN KEY ("renegotiation_requested_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;