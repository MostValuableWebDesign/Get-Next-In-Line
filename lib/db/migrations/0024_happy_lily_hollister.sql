CREATE TABLE "sos_staff_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"compensation_type" text NOT NULL,
	"commission_percent" integer,
	"amount" numeric(10, 2),
	"cadence" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sos_visits" ADD COLUMN "staff_id" integer;--> statement-breakpoint
ALTER TABLE "sos_staff_members" ADD CONSTRAINT "sos_staff_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sos_staff_members_tenant_id_idx" ON "sos_staff_members" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "sos_visits" ADD CONSTRAINT "sos_visits_staff_id_sos_staff_members_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."sos_staff_members"("id") ON DELETE no action ON UPDATE no action;