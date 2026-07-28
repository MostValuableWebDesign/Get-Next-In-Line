CREATE TABLE "coop_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_name" text NOT NULL,
	"subdomain" text NOT NULL,
	"contact_name" text,
	"contact_email" text,
	"category" text,
	"pitch" text,
	"status_token" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"review_notes" text,
	"rejection_reason" text,
	"resulting_tenant_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_applications_status_token_unique" UNIQUE("status_token")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "coop_applications" ADD CONSTRAINT "coop_applications_resulting_tenant_id_tenants_id_fk" FOREIGN KEY ("resulting_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_applications_status_idx" ON "coop_applications" USING btree ("status","created_at" DESC NULLS LAST);