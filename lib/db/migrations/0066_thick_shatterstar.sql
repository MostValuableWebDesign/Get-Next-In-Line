CREATE TABLE "coop_marketing_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_tenant_id" integer NOT NULL,
	"partnership_id" integer NOT NULL,
	"name" text NOT NULL,
	"template_slug" text NOT NULL,
	"headline" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"sms_text" text DEFAULT '' NOT NULL,
	"asset_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scheduled_at" timestamp,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"dispatch_triggered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_marketing_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"access_token" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_marketing_channels_tenant_platform_uq" UNIQUE("tenant_id","platform")
);
--> statement-breakpoint
CREATE TABLE "coop_marketing_link_clicks" (
	"id" serial PRIMARY KEY NOT NULL,
	"link_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_marketing_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"channel" text NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_marketing_links_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "coop_marketing_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"approval" text DEFAULT 'pending' NOT NULL,
	"responded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_marketing_participants_campaign_tenant_uq" UNIQUE("campaign_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "coop_marketing_sends" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"recipients" integer DEFAULT 0 NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"link_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "brand_logo_url" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "brand_primary_color" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "brand_secondary_color" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "coop_marketing_campaigns" ADD CONSTRAINT "coop_marketing_campaigns_creator_tenant_id_tenants_id_fk" FOREIGN KEY ("creator_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_marketing_campaigns" ADD CONSTRAINT "coop_marketing_campaigns_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_marketing_channels" ADD CONSTRAINT "coop_marketing_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_marketing_link_clicks" ADD CONSTRAINT "coop_marketing_link_clicks_link_id_coop_marketing_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."coop_marketing_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_marketing_links" ADD CONSTRAINT "coop_marketing_links_campaign_id_coop_marketing_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."coop_marketing_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_marketing_links" ADD CONSTRAINT "coop_marketing_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_marketing_participants" ADD CONSTRAINT "coop_marketing_participants_campaign_id_coop_marketing_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."coop_marketing_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_marketing_participants" ADD CONSTRAINT "coop_marketing_participants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_marketing_sends" ADD CONSTRAINT "coop_marketing_sends_campaign_id_coop_marketing_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."coop_marketing_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_marketing_sends" ADD CONSTRAINT "coop_marketing_sends_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_marketing_campaigns_creator_idx" ON "coop_marketing_campaigns" USING btree ("creator_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_marketing_campaigns_partnership_idx" ON "coop_marketing_campaigns" USING btree ("partnership_id");--> statement-breakpoint
CREATE INDEX "coop_marketing_campaigns_due_idx" ON "coop_marketing_campaigns" USING btree ("scheduled_at") WHERE dispatch_triggered_at is null and status = 'scheduled';--> statement-breakpoint
CREATE INDEX "coop_marketing_channels_tenant_idx" ON "coop_marketing_channels" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "coop_marketing_link_clicks_link_idx" ON "coop_marketing_link_clicks" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "coop_marketing_links_campaign_idx" ON "coop_marketing_links" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "coop_marketing_participants_tenant_idx" ON "coop_marketing_participants" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "coop_marketing_sends_campaign_idx" ON "coop_marketing_sends" USING btree ("campaign_id");