CREATE TABLE "workforce_people" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"provider_id" text NOT NULL,
	"external_id" text NOT NULL,
	"person_type" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"display_name" text NOT NULL,
	"email" text,
	"normalized_email" text,
	"phone" text,
	"employment_status" text NOT NULL,
	"job_title" text,
	"hire_date" text,
	"termination_date" text,
	"provider_updated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workforce_people_tenant_provider_external_unique" UNIQUE("tenant_id","provider_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "workforce_staff_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"workforce_person_id" integer NOT NULL,
	"gnil_staff_id" integer,
	"gnil_resource_id" integer,
	"link_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workforce_staff_links_person_unique" UNIQUE("workforce_person_id")
);
--> statement-breakpoint
ALTER TABLE "workforce_people" ADD CONSTRAINT "workforce_people_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_staff_links" ADD CONSTRAINT "workforce_staff_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_staff_links" ADD CONSTRAINT "workforce_staff_links_workforce_person_id_workforce_people_id_fk" FOREIGN KEY ("workforce_person_id") REFERENCES "public"."workforce_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_staff_links" ADD CONSTRAINT "workforce_staff_links_gnil_staff_id_sos_staff_members_id_fk" FOREIGN KEY ("gnil_staff_id") REFERENCES "public"."sos_staff_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_staff_links" ADD CONSTRAINT "workforce_staff_links_gnil_resource_id_sos_resources_id_fk" FOREIGN KEY ("gnil_resource_id") REFERENCES "public"."sos_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workforce_people_tenant_status_idx" ON "workforce_people" USING btree ("tenant_id","employment_status");--> statement-breakpoint
CREATE INDEX "workforce_people_tenant_email_idx" ON "workforce_people" USING btree ("tenant_id","normalized_email");--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_staff_links_staff_unique" ON "workforce_staff_links" USING btree ("tenant_id","gnil_staff_id") WHERE "workforce_staff_links"."gnil_staff_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_staff_links_resource_unique" ON "workforce_staff_links" USING btree ("tenant_id","gnil_resource_id") WHERE "workforce_staff_links"."gnil_resource_id" is not null;--> statement-breakpoint
CREATE INDEX "workforce_staff_links_tenant_idx" ON "workforce_staff_links" USING btree ("tenant_id");