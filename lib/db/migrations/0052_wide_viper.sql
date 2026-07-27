CREATE TABLE "coop_community_event_checkins" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"attributed_tenant_id" integer,
	"code" text NOT NULL,
	"attendee_name" text,
	"checked_in_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_community_event_expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"paid_by_tenant_id" integer NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"split_method" text DEFAULT 'even' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_community_event_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"share_weight" numeric(8, 2) DEFAULT '1' NOT NULL,
	"checkin_code" text,
	"responded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_community_event_participants_checkin_code_unique" UNIQUE("checkin_code"),
	CONSTRAINT "coop_community_event_participants_event_tenant_uq" UNIQUE("event_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "coop_community_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"host_tenant_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"location" text,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"unified_code" text NOT NULL,
	"broadcast_triggered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_community_events_unified_code_unique" UNIQUE("unified_code")
);
--> statement-breakpoint
ALTER TABLE "coop_community_event_checkins" ADD CONSTRAINT "coop_community_event_checkins_event_id_coop_community_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."coop_community_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_community_event_checkins" ADD CONSTRAINT "coop_community_event_checkins_attributed_tenant_id_tenants_id_fk" FOREIGN KEY ("attributed_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_community_event_expenses" ADD CONSTRAINT "coop_community_event_expenses_event_id_coop_community_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."coop_community_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_community_event_expenses" ADD CONSTRAINT "coop_community_event_expenses_paid_by_tenant_id_tenants_id_fk" FOREIGN KEY ("paid_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_community_event_participants" ADD CONSTRAINT "coop_community_event_participants_event_id_coop_community_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."coop_community_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_community_event_participants" ADD CONSTRAINT "coop_community_event_participants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_community_events" ADD CONSTRAINT "coop_community_events_host_tenant_id_tenants_id_fk" FOREIGN KEY ("host_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_community_event_checkins_event_idx" ON "coop_community_event_checkins" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "coop_community_event_checkins_tenant_idx" ON "coop_community_event_checkins" USING btree ("attributed_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_community_event_expenses_event_idx" ON "coop_community_event_expenses" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "coop_community_event_participants_tenant_idx" ON "coop_community_event_participants" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "coop_community_events_host_idx" ON "coop_community_events" USING btree ("host_tenant_id");