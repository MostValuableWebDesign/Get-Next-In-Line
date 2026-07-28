ALTER TABLE "sos_customers" ADD COLUMN "email_opt_in" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "to_email" text;