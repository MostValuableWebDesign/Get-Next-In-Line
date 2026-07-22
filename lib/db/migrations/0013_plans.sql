CREATE TABLE "sos_customer_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"plan_id" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"remaining_credits" integer,
	"renews_at" timestamp,
	"purchased_at" timestamp DEFAULT now() NOT NULL,
	"cancelled_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "sos_plan_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_plan_id" integer NOT NULL,
	"customer_id" integer NOT NULL,
	"visit_id" integer,
	"transaction_type" text NOT NULL,
	"amount" numeric(10, 2),
	"credits_delta" integer,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sos_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plan_type" text NOT NULL,
	"description" text,
	"price" numeric(10, 2) NOT NULL,
	"billing_interval" text,
	"discount_percent" integer,
	"credit_count" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sos_customer_plans" ADD CONSTRAINT "sos_customer_plans_customer_id_sos_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."sos_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_customer_plans" ADD CONSTRAINT "sos_customer_plans_plan_id_sos_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."sos_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_plan_transactions" ADD CONSTRAINT "sos_plan_transactions_customer_plan_id_sos_customer_plans_id_fk" FOREIGN KEY ("customer_plan_id") REFERENCES "public"."sos_customer_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_plan_transactions" ADD CONSTRAINT "sos_plan_transactions_customer_id_sos_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."sos_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sos_plan_transactions" ADD CONSTRAINT "sos_plan_transactions_visit_id_sos_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."sos_visits"("id") ON DELETE no action ON UPDATE no action;