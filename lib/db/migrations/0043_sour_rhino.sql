CREATE TABLE "coop_campaign_blasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"tenant_id" integer,
	"customer_id" integer,
	"phone" text NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_campaign_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"responded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_campaign_participants_campaign_tenant_uq" UNIQUE("campaign_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "coop_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_tenant_id" integer NOT NULL,
	"template" text DEFAULT 'custom' NOT NULL,
	"name" text NOT NULL,
	"perk_boost_text" text NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"blast_triggered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coop_campaign_blasts" ADD CONSTRAINT "coop_campaign_blasts_campaign_id_coop_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."coop_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_campaign_blasts" ADD CONSTRAINT "coop_campaign_blasts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_campaign_participants" ADD CONSTRAINT "coop_campaign_participants_campaign_id_coop_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."coop_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_campaign_participants" ADD CONSTRAINT "coop_campaign_participants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_campaigns" ADD CONSTRAINT "coop_campaigns_creator_tenant_id_tenants_id_fk" FOREIGN KEY ("creator_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_campaign_blasts_phone_sent_idx" ON "coop_campaign_blasts" USING btree ("phone","sent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "coop_campaign_blasts_campaign_idx" ON "coop_campaign_blasts" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "coop_campaign_participants_tenant_idx" ON "coop_campaign_participants" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "coop_campaigns_creator_idx" ON "coop_campaigns" USING btree ("creator_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_campaigns_blast_due_idx" ON "coop_campaigns" USING btree ("starts_at") WHERE blast_triggered_at is null;