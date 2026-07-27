ALTER TABLE "sos_settings" ADD COLUMN "coordinates_source" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "density_classification" text DEFAULT 'suburban' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "coop_radius_auto_miles" numeric(5, 1) DEFAULT '4.0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_settings" ADD COLUMN "coop_radius_override_miles" numeric(5, 1);