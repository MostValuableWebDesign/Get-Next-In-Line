CREATE TABLE "merchant_coop_partnerships" (
	"id" serial PRIMARY KEY NOT NULL,
	"host_tenant_id" integer NOT NULL,
	"partner_tenant_id" integer NOT NULL,
	"perk_title" text NOT NULL,
	"perk_description" text,
	"redemption_code" text NOT NULL,
	"industry_barrier_overridden" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_coop_partnerships_redemption_code_unique" UNIQUE("redemption_code")
);
--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD CONSTRAINT "merchant_coop_partnerships_host_tenant_id_tenants_id_fk" FOREIGN KEY ("host_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD CONSTRAINT "merchant_coop_partnerships_partner_tenant_id_tenants_id_fk" FOREIGN KEY ("partner_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_coop_partnerships_host_idx" ON "merchant_coop_partnerships" USING btree ("host_tenant_id");--> statement-breakpoint
CREATE INDEX "merchant_coop_partnerships_partner_idx" ON "merchant_coop_partnerships" USING btree ("partner_tenant_id");