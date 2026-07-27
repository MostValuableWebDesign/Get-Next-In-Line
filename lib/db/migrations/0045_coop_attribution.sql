CREATE TABLE "coop_attribution_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"redemption_id" integer NOT NULL,
	"partnership_id" integer NOT NULL,
	"direction" text NOT NULL,
	"sending_tenant_id" integer,
	"receiving_tenant_id" integer,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_attribution_events_redemption_id_unique" UNIQUE("redemption_id")
);
--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "host_tracking_code" text;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "partner_tracking_code" text;--> statement-breakpoint
ALTER TABLE "coop_attribution_events" ADD CONSTRAINT "coop_attribution_events_redemption_id_coop_perk_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."coop_perk_redemptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_attribution_events" ADD CONSTRAINT "coop_attribution_events_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_attribution_events" ADD CONSTRAINT "coop_attribution_events_sending_tenant_id_tenants_id_fk" FOREIGN KEY ("sending_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_attribution_events" ADD CONSTRAINT "coop_attribution_events_receiving_tenant_id_tenants_id_fk" FOREIGN KEY ("receiving_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_attribution_events_partnership_idx" ON "coop_attribution_events" USING btree ("partnership_id");--> statement-breakpoint
CREATE INDEX "coop_attribution_events_sending_idx" ON "coop_attribution_events" USING btree ("sending_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_attribution_events_receiving_idx" ON "coop_attribution_events" USING btree ("receiving_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_attribution_events_occurred_idx" ON "coop_attribution_events" USING btree ("occurred_at");--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD CONSTRAINT "merchant_coop_partnerships_host_tracking_code_unique" UNIQUE("host_tracking_code");--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD CONSTRAINT "merchant_coop_partnerships_partner_tracking_code_unique" UNIQUE("partner_tracking_code");