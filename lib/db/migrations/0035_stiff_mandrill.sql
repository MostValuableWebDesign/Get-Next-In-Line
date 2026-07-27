CREATE TABLE "coop_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"partnership_id" integer NOT NULL,
	"partner_tenant_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"revenue_amount" numeric(12, 2),
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_monthly_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"month" text NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"claims" integer DEFAULT 0 NOT NULL,
	"crossover_visits" integer DEFAULT 0 NOT NULL,
	"revenue_influenced" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_monthly_reports_tenant_month_uq" UNIQUE("tenant_id","month")
);
--> statement-breakpoint
ALTER TABLE "coop_events" ADD CONSTRAINT "coop_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_events" ADD CONSTRAINT "coop_events_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_events" ADD CONSTRAINT "coop_events_partner_tenant_id_tenants_id_fk" FOREIGN KEY ("partner_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_monthly_reports" ADD CONSTRAINT "coop_monthly_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_events_tenant_type_occurred_idx" ON "coop_events" USING btree ("tenant_id","event_type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "coop_events_partnership_idx" ON "coop_events" USING btree ("partnership_id");