CREATE TABLE "tenant_integration_capabilities" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"capability" text NOT NULL,
	"provider_id" text NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_capabilities_provider_unique" UNIQUE("tenant_id","capability","provider_id")
);
--> statement-breakpoint
CREATE TABLE "workforce_integration_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"provider_id" text NOT NULL,
	"status" text DEFAULT 'not_connected' NOT NULL,
	"access_token_encrypted" text,
	"refresh_token_encrypted" text,
	"token_expires_at" timestamp with time zone,
	"provider_account_id" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"connected_at" timestamp with time zone,
	"last_successful_sync_at" timestamp with time zone,
	"last_sync_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workforce_connections_tenant_provider_unique" UNIQUE("tenant_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "workforce_synced_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"provider_id" text NOT NULL,
	"record_type" text NOT NULL,
	"external_id" text NOT NULL,
	"normalized_data" jsonb NOT NULL,
	"raw_updated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workforce_records_tenant_provider_type_external_unique" UNIQUE("tenant_id","provider_id","record_type","external_id")
);
--> statement-breakpoint
ALTER TABLE "tenant_integration_capabilities" ADD CONSTRAINT "tenant_integration_capabilities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_integration_connections" ADD CONSTRAINT "workforce_integration_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_synced_records" ADD CONSTRAINT "workforce_synced_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_capabilities_one_primary_idx" ON "tenant_integration_capabilities" USING btree ("tenant_id","capability") WHERE "tenant_integration_capabilities"."is_primary" = true;--> statement-breakpoint
CREATE INDEX "tenant_capabilities_tenant_idx" ON "tenant_integration_capabilities" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "workforce_connections_tenant_status_idx" ON "workforce_integration_connections" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "workforce_records_tenant_type_idx" ON "workforce_synced_records" USING btree ("tenant_id","record_type");