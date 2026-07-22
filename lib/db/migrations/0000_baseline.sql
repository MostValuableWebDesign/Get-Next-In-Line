CREATE TABLE "agency_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"markup_percent" numeric(5, 2) DEFAULT '35' NOT NULL,
	"platform_name" text DEFAULT 'Get Next In Line' NOT NULL,
	"deployment_mode" text DEFAULT 'Full-Stack Agency Mode' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"category_slug" text NOT NULL,
	"description" text NOT NULL,
	"wholesale_price" numeric(10, 2) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"slug" text,
	"upstream_vendor" text,
	"hidden_connector" text,
	"proxy_notes" text,
	CONSTRAINT "modules_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "tenant_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"action" text NOT NULL,
	"details" text,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_modules" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"module_id" integer NOT NULL,
	"provisioned_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_modules_tenant_module_unique" UNIQUE("tenant_id","module_id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" serial PRIMARY KEY NOT NULL,
	"brand_name" text NOT NULL,
	"subdomain" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"mrr" numeric(10, 2) DEFAULT '0' NOT NULL,
	"modules_enabled" integer DEFAULT 0 NOT NULL,
	"contact_email" text,
	"contact_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_subdomain_unique" UNIQUE("subdomain")
);
--> statement-breakpoint
ALTER TABLE "tenant_activities" ADD CONSTRAINT "tenant_activities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_modules" ADD CONSTRAINT "tenant_modules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_modules" ADD CONSTRAINT "tenant_modules_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;