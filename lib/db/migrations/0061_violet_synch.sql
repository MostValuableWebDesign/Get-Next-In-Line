CREATE TABLE "coop_coverage_offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"shift_id" integer NOT NULL,
	"offering_tenant_id" integer NOT NULL,
	"staff_id" integer NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_coverage_offers_shift_staff_uq" UNIQUE("shift_id","staff_id")
);
--> statement-breakpoint
CREATE TABLE "coop_coverage_ratings" (
	"id" serial PRIMARY KEY NOT NULL,
	"shift_id" integer NOT NULL,
	"staff_id" integer NOT NULL,
	"rated_by_tenant_id" integer,
	"rating" integer NOT NULL,
	"comment" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_coverage_ratings_shift_id_unique" UNIQUE("shift_id")
);
--> statement-breakpoint
CREATE TABLE "coop_coverage_shifts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"required_skill" text NOT NULL,
	"required_license_state" text NOT NULL,
	"offered_hourly_rate" numeric(10, 2) NOT NULL,
	"notes" text,
	"status" text DEFAULT 'open' NOT NULL,
	"accepted_offer_id" integer,
	"hours_worked" numeric(6, 2),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sos_staff_members" ADD COLUMN "skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_staff_members" ADD COLUMN "certifications" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_staff_members" ADD COLUMN "license_number" text;--> statement-breakpoint
ALTER TABLE "sos_staff_members" ADD COLUMN "license_state" text;--> statement-breakpoint
ALTER TABLE "sos_staff_members" ADD COLUMN "license_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "sos_staff_members" ADD COLUMN "license_verification_status" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_staff_members" ADD COLUMN "license_verified_by" text;--> statement-breakpoint
ALTER TABLE "sos_staff_members" ADD COLUMN "license_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "sos_staff_members" ADD COLUMN "coop_coverage_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "coop_coverage_offers" ADD CONSTRAINT "coop_coverage_offers_shift_id_coop_coverage_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."coop_coverage_shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_coverage_offers" ADD CONSTRAINT "coop_coverage_offers_offering_tenant_id_tenants_id_fk" FOREIGN KEY ("offering_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_coverage_offers" ADD CONSTRAINT "coop_coverage_offers_staff_id_sos_staff_members_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."sos_staff_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_coverage_ratings" ADD CONSTRAINT "coop_coverage_ratings_shift_id_coop_coverage_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."coop_coverage_shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_coverage_ratings" ADD CONSTRAINT "coop_coverage_ratings_staff_id_sos_staff_members_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."sos_staff_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_coverage_ratings" ADD CONSTRAINT "coop_coverage_ratings_rated_by_tenant_id_tenants_id_fk" FOREIGN KEY ("rated_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_coverage_shifts" ADD CONSTRAINT "coop_coverage_shifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_coverage_offers_shift_idx" ON "coop_coverage_offers" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "coop_coverage_offers_tenant_idx" ON "coop_coverage_offers" USING btree ("offering_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_coverage_ratings_staff_idx" ON "coop_coverage_ratings" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "coop_coverage_shifts_tenant_idx" ON "coop_coverage_shifts" USING btree ("tenant_id");