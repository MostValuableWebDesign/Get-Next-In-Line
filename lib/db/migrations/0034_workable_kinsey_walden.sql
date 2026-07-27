CREATE TABLE "coop_isolation_pairs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_a_id" integer NOT NULL,
	"tenant_b_id" integer NOT NULL,
	"sub_category" text NOT NULL,
	"match_basis" text DEFAULT 'radius' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_isolation_pairs_pair_uq" UNIQUE("tenant_a_id","tenant_b_id")
);
--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "coop_sub_category" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "coop_radius_miles" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "coop_isolation_pairs" ADD CONSTRAINT "coop_isolation_pairs_tenant_a_id_tenants_id_fk" FOREIGN KEY ("tenant_a_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_isolation_pairs" ADD CONSTRAINT "coop_isolation_pairs_tenant_b_id_tenants_id_fk" FOREIGN KEY ("tenant_b_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_isolation_pairs_a_idx" ON "coop_isolation_pairs" USING btree ("tenant_a_id");--> statement-breakpoint
CREATE INDEX "coop_isolation_pairs_b_idx" ON "coop_isolation_pairs" USING btree ("tenant_b_id");