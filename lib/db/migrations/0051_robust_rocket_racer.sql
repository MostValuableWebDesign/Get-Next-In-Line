CREATE TABLE "emergency_broadcast_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"broadcast_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"sms_dispatched_at" timestamp,
	"sms_sent_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "emergency_broadcast_targets_unique" UNIQUE("broadcast_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "emergency_broadcasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"sender_tenant_id" integer,
	"scope" text NOT NULL,
	"severity" text NOT NULL,
	"alert_type" text NOT NULL,
	"headline" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emergency_checkins" (
	"id" serial PRIMARY KEY NOT NULL,
	"broadcast_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "emergency_checkins_unique" UNIQUE("broadcast_id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "emergency_broadcast_targets" ADD CONSTRAINT "emergency_broadcast_targets_broadcast_id_emergency_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."emergency_broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_broadcast_targets" ADD CONSTRAINT "emergency_broadcast_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_broadcasts" ADD CONSTRAINT "emergency_broadcasts_sender_tenant_id_tenants_id_fk" FOREIGN KEY ("sender_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_checkins" ADD CONSTRAINT "emergency_checkins_broadcast_id_emergency_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."emergency_broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_checkins" ADD CONSTRAINT "emergency_checkins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "emergency_broadcast_targets_tenant_idx" ON "emergency_broadcast_targets" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "emergency_broadcasts_status_idx" ON "emergency_broadcasts" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "emergency_checkins_tenant_idx" ON "emergency_checkins" USING btree ("tenant_id");