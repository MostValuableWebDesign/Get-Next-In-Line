CREATE TABLE "partner_connection_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"details" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer,
	"module_id" integer NOT NULL,
	"status" text DEFAULT 'not_connected' NOT NULL,
	"oauth_state" text,
	"access_token_encrypted" text,
	"refresh_token_encrypted" text,
	"last_sync_at" timestamp,
	"connected_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "partner_connections_tenant_module_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","module_id")
);
--> statement-breakpoint
ALTER TABLE "partner_connection_events" ADD CONSTRAINT "partner_connection_events_connection_id_partner_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."partner_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_connections" ADD CONSTRAINT "partner_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_connections" ADD CONSTRAINT "partner_connections_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_connection_events_connection_created_idx" ON "partner_connection_events" USING btree ("connection_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);