CREATE TABLE "client_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"preferred_channel" text DEFAULT 'sms' NOT NULL,
	"sms_opt_in" boolean DEFAULT true NOT NULL,
	"last_visit_at" timestamp,
	"next_visit_at" timestamp,
	"average_cycle_days" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"rule_type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_profile_id" integer,
	"rule_id" integer,
	"job_type" text DEFAULT 'manual' NOT NULL,
	"channel" text DEFAULT 'sms' NOT NULL,
	"to_number" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_profiles" ADD CONSTRAINT "client_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_rules" ADD CONSTRAINT "engagement_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_client_profile_id_client_profiles_id_fk" FOREIGN KEY ("client_profile_id") REFERENCES "public"."client_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_rule_id_engagement_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."engagement_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_profiles_tenant_next_visit_idx" ON "client_profiles" USING btree ("tenant_id","next_visit_at");--> statement-breakpoint
CREATE INDEX "client_profiles_tenant_last_visit_idx" ON "client_profiles" USING btree ("tenant_id","last_visit_at");--> statement-breakpoint
CREATE INDEX "engagement_rules_tenant_rule_type_idx" ON "engagement_rules" USING btree ("tenant_id","rule_type");--> statement-breakpoint
CREATE INDEX "message_logs_tenant_created_idx" ON "message_logs" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "message_logs_client_job_created_idx" ON "message_logs" USING btree ("client_profile_id","job_type","created_at" DESC NULLS LAST);