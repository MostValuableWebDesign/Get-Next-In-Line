ALTER TABLE "coop_featured_boosts" ADD COLUMN "payment_mode" text DEFAULT 'simulated' NOT NULL;--> statement-breakpoint
ALTER TABLE "coop_featured_boosts" ADD COLUMN "stripe_payment_intent_id" text;--> statement-breakpoint
ALTER TABLE "coop_featured_boosts" ADD COLUMN "payment_failure_reason" text;--> statement-breakpoint
ALTER TABLE "coop_featured_boosts" ADD COLUMN "retry_operation" text;--> statement-breakpoint
ALTER TABLE "coop_featured_boosts" ADD COLUMN "retry_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "coop_featured_boosts" ADD COLUMN "next_retry_at" timestamp;