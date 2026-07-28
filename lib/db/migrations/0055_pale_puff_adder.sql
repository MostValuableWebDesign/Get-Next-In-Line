CREATE TABLE "coop_retail_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"partnership_id" integer NOT NULL,
	"host_tenant_id" integer NOT NULL,
	"owner_tenant_id" integer NOT NULL,
	"name" text NOT NULL,
	"quantity_on_shelf" integer DEFAULT 0 NOT NULL,
	"unit_price" numeric(10, 2) NOT NULL,
	"owner_share_percent" integer NOT NULL,
	"low_stock_threshold" integer DEFAULT 3 NOT NULL,
	"low_stock_alerted_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_retail_ledger_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"partnership_id" integer NOT NULL,
	"movement_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"counterparty_tenant_id" integer NOT NULL,
	"role" text NOT NULL,
	"units_sold" integer NOT NULL,
	"gross_amount" numeric(12, 2) NOT NULL,
	"share_amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_retail_stock_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"movement_type" text NOT NULL,
	"quantity_delta" integer NOT NULL,
	"note" text,
	"recorded_by_tenant_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coop_retail_items" ADD CONSTRAINT "coop_retail_items_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_retail_items" ADD CONSTRAINT "coop_retail_items_host_tenant_id_tenants_id_fk" FOREIGN KEY ("host_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_retail_items" ADD CONSTRAINT "coop_retail_items_owner_tenant_id_tenants_id_fk" FOREIGN KEY ("owner_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_retail_ledger_entries" ADD CONSTRAINT "coop_retail_ledger_entries_item_id_coop_retail_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."coop_retail_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_retail_ledger_entries" ADD CONSTRAINT "coop_retail_ledger_entries_partnership_id_merchant_coop_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."merchant_coop_partnerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_retail_ledger_entries" ADD CONSTRAINT "coop_retail_ledger_entries_movement_id_coop_retail_stock_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."coop_retail_stock_movements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_retail_ledger_entries" ADD CONSTRAINT "coop_retail_ledger_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_retail_ledger_entries" ADD CONSTRAINT "coop_retail_ledger_entries_counterparty_tenant_id_tenants_id_fk" FOREIGN KEY ("counterparty_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_retail_stock_movements" ADD CONSTRAINT "coop_retail_stock_movements_item_id_coop_retail_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."coop_retail_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_retail_stock_movements" ADD CONSTRAINT "coop_retail_stock_movements_recorded_by_tenant_id_tenants_id_fk" FOREIGN KEY ("recorded_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coop_retail_items_host_idx" ON "coop_retail_items" USING btree ("host_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_retail_items_owner_idx" ON "coop_retail_items" USING btree ("owner_tenant_id");--> statement-breakpoint
CREATE INDEX "coop_retail_items_partnership_idx" ON "coop_retail_items" USING btree ("partnership_id");--> statement-breakpoint
CREATE INDEX "coop_retail_ledger_tenant_idx" ON "coop_retail_ledger_entries" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "coop_retail_ledger_item_idx" ON "coop_retail_ledger_entries" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "coop_retail_stock_movements_item_idx" ON "coop_retail_stock_movements" USING btree ("item_id","created_at" DESC NULLS LAST);