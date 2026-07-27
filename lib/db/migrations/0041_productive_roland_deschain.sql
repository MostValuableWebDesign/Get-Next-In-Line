CREATE TABLE "coop_suggestion_dismissals" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"dismissed_tenant_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_suggestion_dismissals_pair_uq" UNIQUE("tenant_id","dismissed_tenant_id")
);
--> statement-breakpoint
CREATE TABLE "coop_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"suggested_tenant_id" integer NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_suggestions_tenant_suggested_uq" UNIQUE("tenant_id","suggested_tenant_id")
);
--> statement-breakpoint
ALTER TABLE "coop_suggestion_dismissals" ADD CONSTRAINT "coop_suggestion_dismissals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_suggestion_dismissals" ADD CONSTRAINT "coop_suggestion_dismissals_dismissed_tenant_id_tenants_id_fk" FOREIGN KEY ("dismissed_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_suggestions" ADD CONSTRAINT "coop_suggestions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_suggestions" ADD CONSTRAINT "coop_suggestions_suggested_tenant_id_tenants_id_fk" FOREIGN KEY ("suggested_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_suggestion_dismissals_tenant_idx" ON "coop_suggestion_dismissals" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "coop_suggestions_tenant_idx" ON "coop_suggestions" USING btree ("tenant_id");