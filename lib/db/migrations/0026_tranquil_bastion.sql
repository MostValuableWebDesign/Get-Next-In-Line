ALTER TABLE "sos_settings" ADD COLUMN "open_time" text DEFAULT '09:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "close_time" text DEFAULT '17:00' NOT NULL;