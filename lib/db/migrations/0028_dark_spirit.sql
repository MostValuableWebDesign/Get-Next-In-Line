CREATE TABLE "attribution_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"campaign_code" text NOT NULL,
	"event_type" text DEFAULT 'click' NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"tenant_id" integer NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attribution_events_code_occurred_idx" ON "attribution_events" USING btree ("campaign_code","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "attribution_events_tenant_idx" ON "attribution_events" USING btree ("tenant_id");