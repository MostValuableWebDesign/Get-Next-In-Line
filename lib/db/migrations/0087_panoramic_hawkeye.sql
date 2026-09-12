CREATE TABLE "workforce_connection_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_oauth_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"provider_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"session_binding_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workforce_oauth_states_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
ALTER TABLE "workforce_connection_events" ADD CONSTRAINT "workforce_connection_events_connection_id_workforce_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."workforce_integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_oauth_states" ADD CONSTRAINT "workforce_oauth_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workforce_connection_events_connection_created_idx" ON "workforce_connection_events" USING btree ("connection_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workforce_oauth_states_tenant_provider_idx" ON "workforce_oauth_states" USING btree ("tenant_id","provider_id","created_at" DESC NULLS LAST);