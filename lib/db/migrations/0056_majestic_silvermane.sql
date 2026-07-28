CREATE TABLE "coop_partner_ratings" (
	"id" serial PRIMARY KEY NOT NULL,
	"partnership_id" integer NOT NULL,
	"rater_tenant_id" integer NOT NULL,
	"rated_tenant_id" integer NOT NULL,
	"reliability" integer NOT NULL,
	"professionalism" integer NOT NULL,
	"traffic_value" integer NOT NULL,
	"comment" text,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_reputation_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"score" numeric(4, 2),
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_reputation_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"score" numeric(4, 2),
	"rater_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"flagged_at" timestamp,
	"decoupled_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_reputation_states_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
ALTER TABLE "coop_partner_ratings" ADD CONSTRAINT "coop_partner_ratings_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_partner_ratings" ADD CONSTRAINT "coop_partner_ratings_rater_tenant_id_tenants_id_fk" FOREIGN KEY ("rater_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_partner_ratings" ADD CONSTRAINT "coop_partner_ratings_rated_tenant_id_tenants_id_fk" FOREIGN KEY ("rated_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_reputation_events" ADD CONSTRAINT "coop_reputation_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_reputation_states" ADD CONSTRAINT "coop_reputation_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coop_partner_ratings_current_pair_uq" ON "coop_partner_ratings" USING btree ("rater_tenant_id","rated_tenant_id") WHERE is_current;--> statement-breakpoint
CREATE INDEX "coop_partner_ratings_rated_idx" ON "coop_partner_ratings" USING btree ("rated_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_reputation_events_tenant_idx" ON "coop_reputation_events" USING btree ("tenant_id","created_at" DESC NULLS LAST);