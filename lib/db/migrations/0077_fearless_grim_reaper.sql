CREATE TABLE "module_checkout_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"stripe_session_id" text NOT NULL,
	"checkout_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"items" jsonb NOT NULL,
	"total_wholesale" numeric(10, 2) NOT NULL,
	"total_resale" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "module_checkout_sessions_stripe_session_id_unique" UNIQUE("stripe_session_id")
);
--> statement-breakpoint
ALTER TABLE "tenant_modules" ADD COLUMN "payment_mode" text DEFAULT 'simulated' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_modules" ADD COLUMN "stripe_checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "module_checkout_sessions" ADD CONSTRAINT "module_checkout_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;