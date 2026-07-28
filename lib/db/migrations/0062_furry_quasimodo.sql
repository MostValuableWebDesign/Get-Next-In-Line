CREATE TABLE "coop_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"partnership_id" integer NOT NULL,
	"redemption_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"customer_phone" text NOT NULL,
	"customer_name" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"rating" integer,
	"would_recommend" boolean,
	"feedback_text" text,
	"sentiment_label" text,
	"sentiment_score" numeric(4, 3),
	"themes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sentiment_used_ai" boolean DEFAULT false NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"responded_at" timestamp,
	CONSTRAINT "coop_feedback_redemption_uq" UNIQUE("redemption_id")
);
--> statement-breakpoint
CREATE TABLE "coop_sentiment_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"period_type" text NOT NULL,
	"period_key" text NOT NULL,
	"rankings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_sentiment_reports_tenant_period_uq" UNIQUE("tenant_id","period_type","period_key")
);
--> statement-breakpoint
ALTER TABLE "coop_feedback" ADD CONSTRAINT "coop_feedback_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_feedback" ADD CONSTRAINT "coop_feedback_redemption_id_coop_perk_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."coop_perk_redemptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_feedback" ADD CONSTRAINT "coop_feedback_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_sentiment_reports" ADD CONSTRAINT "coop_sentiment_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_feedback_tenant_idx" ON "coop_feedback" USING btree ("tenant_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "coop_feedback_partnership_idx" ON "coop_feedback" USING btree ("partnership_id");--> statement-breakpoint
CREATE INDEX "coop_feedback_phone_status_idx" ON "coop_feedback" USING btree ("customer_phone","status","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "coop_sentiment_reports_tenant_idx" ON "coop_sentiment_reports" USING btree ("tenant_id","created_at" DESC NULLS LAST);