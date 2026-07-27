CREATE TABLE "franchise_orgs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"autonomy_policy" text DEFAULT 'allowed' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_partnership_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"storefront_tenant_id" integer NOT NULL,
	"target_tenant_id" integer NOT NULL,
	"perk_title" text NOT NULL,
	"perk_description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" integer,
	"decided_by_user_id" integer,
	"decided_at" timestamp,
	"partnership_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_perk_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"title" text NOT NULL,
	"redemption_terms" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_regions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_regions_org_name_uq" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "franchise_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" text NOT NULL,
	"region_id" integer,
	"tenant_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_roles_org_user_uq" UNIQUE("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "franchise_storefronts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"region_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_storefronts_tenant_uq" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "franchise_template_deployments" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"partnership_id" integer,
	"status" text DEFAULT 'deployed' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_template_deployments_uq" UNIQUE("template_id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "franchise_partnership_requests" ADD CONSTRAINT "franchise_partnership_requests_org_id_franchise_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."franchise_orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_partnership_requests" ADD CONSTRAINT "franchise_partnership_requests_storefront_tenant_id_tenants_id_fk" FOREIGN KEY ("storefront_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_partnership_requests" ADD CONSTRAINT "franchise_partnership_requests_target_tenant_id_tenants_id_fk" FOREIGN KEY ("target_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_partnership_requests" ADD CONSTRAINT "franchise_partnership_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_partnership_requests" ADD CONSTRAINT "franchise_partnership_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_partnership_requests" ADD CONSTRAINT "franchise_partnership_requests_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_perk_templates" ADD CONSTRAINT "franchise_perk_templates_org_id_franchise_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."franchise_orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_regions" ADD CONSTRAINT "franchise_regions_org_id_franchise_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."franchise_orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_roles" ADD CONSTRAINT "franchise_roles_org_id_franchise_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."franchise_orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_roles" ADD CONSTRAINT "franchise_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_roles" ADD CONSTRAINT "franchise_roles_region_id_franchise_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."franchise_regions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_roles" ADD CONSTRAINT "franchise_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_storefronts" ADD CONSTRAINT "franchise_storefronts_org_id_franchise_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."franchise_orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_storefronts" ADD CONSTRAINT "franchise_storefronts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_storefronts" ADD CONSTRAINT "franchise_storefronts_region_id_franchise_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."franchise_regions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_template_deployments" ADD CONSTRAINT "franchise_template_deployments_template_id_franchise_perk_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."franchise_perk_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_template_deployments" ADD CONSTRAINT "franchise_template_deployments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_template_deployments" ADD CONSTRAINT "franchise_template_deployments_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "franchise_partnership_requests_org_idx" ON "franchise_partnership_requests" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "franchise_perk_templates_org_idx" ON "franchise_perk_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "franchise_regions_org_idx" ON "franchise_regions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "franchise_roles_user_idx" ON "franchise_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "franchise_storefronts_org_idx" ON "franchise_storefronts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "franchise_template_deployments_tenant_idx" ON "franchise_template_deployments" USING btree ("tenant_id");