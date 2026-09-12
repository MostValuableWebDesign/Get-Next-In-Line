CREATE TABLE "workforce_capability_syncs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"provider_id" text NOT NULL,
	"capability" text NOT NULL,
	"status" text NOT NULL,
	"records_read" integer DEFAULT 0 NOT NULL,
	"records_written" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_successful_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workforce_capability_sync_tenant_provider_capability_unique" UNIQUE("tenant_id","provider_id","capability")
);
--> statement-breakpoint
CREATE TABLE "workforce_compensations" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"provider_id" text NOT NULL,
	"external_employee_id" text NOT NULL,
	"external_job_id" text NOT NULL,
	"workforce_person_id" integer,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"interval" text NOT NULL,
	"effective_from" text,
	"effective_to" text,
	"provider_updated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workforce_compensations_tenant_provider_job_unique" UNIQUE("tenant_id","provider_id","external_job_id")
);
--> statement-breakpoint
CREATE TABLE "workforce_payroll_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"provider_id" text NOT NULL,
	"external_id" text NOT NULL,
	"status" text NOT NULL,
	"pay_period_start" text NOT NULL,
	"pay_period_end" text NOT NULL,
	"payment_date" text,
	"processed" boolean NOT NULL,
	"processed_date" text,
	"calculated_at" timestamp with time zone,
	"gross_pay_cents" integer,
	"net_pay_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workforce_payroll_runs_tenant_provider_external_unique" UNIQUE("tenant_id","provider_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "workforce_capability_syncs" ADD CONSTRAINT "workforce_capability_syncs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_compensations" ADD CONSTRAINT "workforce_compensations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_compensations" ADD CONSTRAINT "workforce_compensations_person_tenant_fk" FOREIGN KEY ("tenant_id","workforce_person_id") REFERENCES "public"."workforce_people"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_payroll_runs" ADD CONSTRAINT "workforce_payroll_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workforce_compensations_tenant_employee_idx" ON "workforce_compensations" USING btree ("tenant_id","external_employee_id");--> statement-breakpoint
CREATE INDEX "workforce_payroll_runs_tenant_period_idx" ON "workforce_payroll_runs" USING btree ("tenant_id","pay_period_start");