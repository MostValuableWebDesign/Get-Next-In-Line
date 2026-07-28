ALTER TABLE "sos_deposit_holds" ADD COLUMN "retry_operation" text;--> statement-breakpoint
ALTER TABLE "sos_deposit_holds" ADD COLUMN "retry_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sos_deposit_holds" ADD COLUMN "next_retry_at" timestamp;