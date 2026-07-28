CREATE TABLE "procurement_group_buy_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_buy_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "procurement_gb_participants_gb_tenant_uq" UNIQUE("group_buy_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "procurement_group_buys" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_item_id" integer NOT NULL,
	"organizer_tenant_id" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"achieved_tier_min_qty" integer,
	"achieved_unit_price" numeric(10, 2),
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procurement_ledger_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_buy_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(10, 2) NOT NULL,
	"base_unit_price" numeric(10, 2) NOT NULL,
	"share_amount" numeric(12, 2) NOT NULL,
	"savings_amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "procurement_ledger_gb_tenant_uq" UNIQUE("group_buy_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "procurement_supply_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"name" text NOT NULL,
	"unit" text DEFAULT 'unit' NOT NULL,
	"on_hand_qty" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 0 NOT NULL,
	"vendor_item_id" integer,
	"auto_request_enabled" boolean DEFAULT false NOT NULL,
	"last_reorder_reminded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procurement_vendor_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" integer NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"base_price" numeric(10, 2) NOT NULL,
	"bulk_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procurement_vendors" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"region" text NOT NULL,
	"contact_email" text,
	"notes" text,
	"is_verified" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "procurement_group_buy_participants" ADD CONSTRAINT "procurement_group_buy_participants_group_buy_id_procurement_group_buys_id_fk" FOREIGN KEY ("group_buy_id") REFERENCES "public"."procurement_group_buys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_group_buy_participants" ADD CONSTRAINT "procurement_group_buy_participants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_group_buys" ADD CONSTRAINT "procurement_group_buys_vendor_item_id_procurement_vendor_items_id_fk" FOREIGN KEY ("vendor_item_id") REFERENCES "public"."procurement_vendor_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_group_buys" ADD CONSTRAINT "procurement_group_buys_organizer_tenant_id_tenants_id_fk" FOREIGN KEY ("organizer_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_ledger_entries" ADD CONSTRAINT "procurement_ledger_entries_group_buy_id_procurement_group_buys_id_fk" FOREIGN KEY ("group_buy_id") REFERENCES "public"."procurement_group_buys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_ledger_entries" ADD CONSTRAINT "procurement_ledger_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_supply_items" ADD CONSTRAINT "procurement_supply_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_supply_items" ADD CONSTRAINT "procurement_supply_items_vendor_item_id_procurement_vendor_items_id_fk" FOREIGN KEY ("vendor_item_id") REFERENCES "public"."procurement_vendor_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_vendor_items" ADD CONSTRAINT "procurement_vendor_items_vendor_id_procurement_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."procurement_vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "procurement_gb_participants_tenant_idx" ON "procurement_group_buy_participants" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "procurement_group_buys_item_idx" ON "procurement_group_buys" USING btree ("vendor_item_id");--> statement-breakpoint
CREATE INDEX "procurement_group_buys_organizer_idx" ON "procurement_group_buys" USING btree ("organizer_tenant_id");--> statement-breakpoint
CREATE INDEX "procurement_ledger_tenant_idx" ON "procurement_ledger_entries" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "procurement_supply_items_tenant_idx" ON "procurement_supply_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "procurement_vendor_items_vendor_idx" ON "procurement_vendor_items" USING btree ("vendor_id");