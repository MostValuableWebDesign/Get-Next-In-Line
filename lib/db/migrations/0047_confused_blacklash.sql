CREATE TABLE "coop_plaza_conflicts" (
	"id" serial PRIMARY KEY NOT NULL,
	"requester_tenant_id" integer NOT NULL,
	"blocked_partner_tenant_id" integer NOT NULL,
	"existing_partnership_id" integer,
	"category" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"released_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coop_plaza_conflicts_trio_uq" UNIQUE("requester_tenant_id","blocked_partner_tenant_id","category")
);
--> statement-breakpoint
ALTER TABLE "coop_plaza_conflicts" ADD CONSTRAINT "coop_plaza_conflicts_requester_tenant_id_tenants_id_fk" FOREIGN KEY ("requester_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_plaza_conflicts" ADD CONSTRAINT "coop_plaza_conflicts_blocked_partner_tenant_id_tenants_id_fk" FOREIGN KEY ("blocked_partner_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_plaza_conflicts" ADD CONSTRAINT "coop_plaza_conflicts_existing_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("existing_partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_plaza_conflicts_requester_idx" ON "coop_plaza_conflicts" USING btree ("requester_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_plaza_conflicts_blocked_idx" ON "coop_plaza_conflicts" USING btree ("blocked_partner_tenant_id");