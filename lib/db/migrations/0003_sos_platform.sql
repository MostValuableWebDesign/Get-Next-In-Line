CREATE TABLE "sos_appointments" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"service_type" text NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"source" text DEFAULT 'staff' NOT NULL,
	"resource_id" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sos_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_number" text NOT NULL,
	"caller_name" text,
	"intent" text NOT NULL,
	"transcript_summary" text,
	"outcome" text DEFAULT 'no_action' NOT NULL,
	"appointment_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sos_customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"sms_opt_in" boolean DEFAULT true NOT NULL,
	"visit_count" integer DEFAULT 0 NOT NULL,
	"last_visit_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sos_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer,
	"to_number" text,
	"direction" text DEFAULT 'outbound' NOT NULL,
	"body" text NOT NULL,
	"kind" text DEFAULT 'manual' NOT NULL,
	"delivery_status" text DEFAULT 'simulated' NOT NULL,
	"provider_sid" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sos_resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"resource_type" text NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"current_visit_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sos_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_name" text DEFAULT 'SOS Operations' NOT NULL,
	"industry_type" text DEFAULT 'salon' NOT NULL,
	"resource_label" text DEFAULT 'Chair' NOT NULL,
	"ai_receptionist_enabled" boolean DEFAULT true NOT NULL,
	"waitlist_auto_fill_enabled" boolean DEFAULT true NOT NULL,
	"sms_from_number" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sos_visits" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"status" text DEFAULT 'checked_in' NOT NULL,
	"service_type" text NOT NULL,
	"party_size" integer DEFAULT 1 NOT NULL,
	"resource_id" integer,
	"estimated_wait_minutes" integer,
	"payment_amount" numeric(10, 2),
	"checked_in_at" timestamp DEFAULT now() NOT NULL,
	"service_started_at" timestamp,
	"checked_out_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "sos_waitlist_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"desired_service" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"notified_at" timestamp,
	"open_slot_starts_at" timestamp,
	"open_slot_ends_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sos_appointments" ADD CONSTRAINT "sos_appointments_customer_id_sos_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."sos_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_appointments" ADD CONSTRAINT "sos_appointments_resource_id_sos_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."sos_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_calls" ADD CONSTRAINT "sos_calls_appointment_id_sos_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."sos_appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_messages" ADD CONSTRAINT "sos_messages_customer_id_sos_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."sos_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_visits" ADD CONSTRAINT "sos_visits_customer_id_sos_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."sos_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_visits" ADD CONSTRAINT "sos_visits_resource_id_sos_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."sos_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_waitlist_entries" ADD CONSTRAINT "sos_waitlist_entries_customer_id_sos_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."sos_customers"("id") ON DELETE no action ON UPDATE no action;