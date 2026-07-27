CREATE TABLE "coop_disputes" (
	"id" serial PRIMARY KEY NOT NULL,
	"partnership_id" integer NOT NULL,
	"reporting_tenant_id" integer NOT NULL,
	"reported_tenant_id" integer NOT NULL,
	"category" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'open' NOT NULL,
	"grace_deadline_at" timestamp NOT NULL,
	"escalated_at" timestamp,
	"resolved_at" timestamp,
	"withdrawn_at" timestamp,
	"mediation_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "dispute_suspended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_coop_partnerships" ADD COLUMN "banned_at" timestamp;--> statement-breakpoint
ALTER TABLE "coop_disputes" ADD CONSTRAINT "coop_disputes_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_disputes" ADD CONSTRAINT "coop_disputes_reporting_tenant_id_tenants_id_fk" FOREIGN KEY ("reporting_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_disputes" ADD CONSTRAINT "coop_disputes_reported_tenant_id_tenants_id_fk" FOREIGN KEY ("reported_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_disputes_partnership_idx" ON "coop_disputes" USING btree ("partnership_id");--> statement-breakpoint
CREATE INDEX "coop_disputes_status_idx" ON "coop_disputes" USING btree ("status");