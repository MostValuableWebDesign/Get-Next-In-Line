CREATE TABLE "sos_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer,
	"author_name" text NOT NULL,
	"rating" integer NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "seo_description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "public_phone" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "street_address" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "address_locality" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "address_region" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "postal_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "latitude" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "longitude" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "business_category" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_reviews" ADD CONSTRAINT "sos_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sos_reviews_tenant_id_idx" ON "sos_reviews" USING btree ("tenant_id");