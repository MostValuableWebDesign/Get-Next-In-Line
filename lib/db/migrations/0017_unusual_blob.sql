ALTER TABLE "sos_deposit_holds" ALTER COLUMN "status" SET DEFAULT 'pending_authorization';--> statement-breakpoint
ALTER TABLE "sos_deposit_holds" ADD COLUMN "stripe_payment_intent_id" text;--> statement-breakpoint
ALTER TABLE "sos_deposit_holds" ADD COLUMN "stripe_checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "sos_deposit_holds" ADD COLUMN "checkout_url" text;