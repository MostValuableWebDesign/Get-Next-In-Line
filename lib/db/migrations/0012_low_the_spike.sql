CREATE TABLE "sos_deposit_holds" (
	"id" serial PRIMARY KEY NOT NULL,
	"appointment_id" integer NOT NULL,
	"deposit_amount" numeric(10, 2) NOT NULL,
	"fee_amount" numeric(10, 2) NOT NULL,
	"cancellation_window_hours" integer NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"outcome_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	CONSTRAINT "sos_deposit_holds_appointment_id_unique" UNIQUE("appointment_id")
);
--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "no_show_shield_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "no_show_deposit_amount" numeric(10, 2) DEFAULT '25.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "no_show_cancellation_window_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "no_show_fee" numeric(10, 2) DEFAULT '25.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_deposit_holds" ADD CONSTRAINT "sos_deposit_holds_appointment_id_sos_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."sos_appointments"("id") ON DELETE cascade ON UPDATE no action;