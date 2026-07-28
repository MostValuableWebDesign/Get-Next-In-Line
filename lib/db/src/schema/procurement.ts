import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
  jsonb,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./agency";

// ── Co-Op Supplier & Local Procurement Marketplace ───────────────────────────
// Verified regional B2B vendor directory (admin-curated), collaborative
// group-buying with volume-discount tiers and automated proportional cost
// splitting, and per-merchant supply inventory with low-stock thresholds that
// drive reorder reminders / auto group-buy replenishment. No real payments —
// the ledger records shares only.

/** A bulk pricing tier: at or above minQty units pooled, each unit costs unitPrice. */
export type ProcurementBulkTier = { minQty: number; unitPrice: number };

// Admin-curated directory of regional B2B suppliers. Merchants only ever see
// verified vendors; unverified rows are admin-console-only drafts.
export const procurementVendorsTable = pgTable("procurement_vendors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // Supply category, e.g. "sanitation", "styling", "packaging", "office".
  category: text("category").notNull(),
  region: text("region").notNull(),
  contactEmail: text("contact_email"),
  notes: text("notes"),
  // Only verified vendors are served through merchant-facing endpoints.
  isVerified: boolean("is_verified").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ProcurementVendor = typeof procurementVendorsTable.$inferSelect;

// A supply item a vendor offers, with solo unit pricing and volume-discount
// tiers. Tiers are stored as a jsonb array sorted by minQty ascending; the
// achieved tier of a group buy is the highest tier whose minQty the pooled
// quantity reaches.
export const procurementVendorItemsTable = pgTable(
  "procurement_vendor_items",
  {
    id: serial("id").primaryKey(),
    vendorId: integer("vendor_id")
      .notNull()
      .references(() => procurementVendorsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Unit of sale, e.g. "case of 12", "gallon", "box of 500".
    unit: text("unit").notNull(),
    // Solo (non-pooled) price per unit — the baseline savings are measured against.
    basePrice: numeric("base_price", { precision: 10, scale: 2 }).notNull(),
    bulkTiers: jsonb("bulk_tiers").$type<ProcurementBulkTier[]>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("procurement_vendor_items_vendor_idx").on(t.vendorId)]
);

export type ProcurementVendorItem = typeof procurementVendorItemsTable.$inferSelect;

// A collaborative group buy on one vendor item. Opened by an organizer
// tenant; other co-op network tenants join with quantities. On close the
// achieved tier is computed from the pooled quantity and frozen here, and the
// immutable cost-split ledger rows are generated.
export const procurementGroupBuysTable = pgTable(
  "procurement_group_buys",
  {
    id: serial("id").primaryKey(),
    vendorItemId: integer("vendor_item_id")
      .notNull()
      .references(() => procurementVendorItemsTable.id, { onDelete: "cascade" }),
    organizerTenantId: integer("organizer_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // open | closed | cancelled
    status: text("status").notNull().default("open"),
    // Frozen at close time: the bulk tier the pool reached (NULL = no tier
    // reached, base pricing applied) and the realized per-unit price.
    achievedTierMinQty: integer("achieved_tier_min_qty"),
    achievedUnitPrice: numeric("achieved_unit_price", { precision: 10, scale: 2 }),
    closedAt: timestamp("closed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("procurement_group_buys_item_idx").on(t.vendorItemId),
    index("procurement_group_buys_organizer_idx").on(t.organizerTenantId),
  ]
);

export type ProcurementGroupBuy = typeof procurementGroupBuysTable.$inferSelect;

// One participant line per tenant per group buy (organizer included). The
// unique pair makes joins idempotent upserts — re-joining adjusts quantity.
export const procurementGroupBuyParticipantsTable = pgTable(
  "procurement_group_buy_participants",
  {
    id: serial("id").primaryKey(),
    groupBuyId: integer("group_buy_id")
      .notNull()
      .references(() => procurementGroupBuysTable.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("procurement_gb_participants_gb_tenant_uq").on(t.groupBuyId, t.tenantId),
    index("procurement_gb_participants_tenant_idx").on(t.tenantId),
  ]
);

export type ProcurementGroupBuyParticipant =
  typeof procurementGroupBuyParticipantsTable.$inferSelect;

// Immutable cost-split ledger, generated exactly once when a group buy
// closes: each participant's proportional share (quantity × achieved unit
// price) and their savings versus solo (base) pricing. Never updated.
export const procurementLedgerEntriesTable = pgTable(
  "procurement_ledger_entries",
  {
    id: serial("id").primaryKey(),
    groupBuyId: integer("group_buy_id")
      .notNull()
      .references(() => procurementGroupBuysTable.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    // Realized per-unit price at the achieved tier (== base price when no
    // tier was reached), frozen at close time.
    unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
    // Solo per-unit price at close time, frozen for savings math.
    baseUnitPrice: numeric("base_unit_price", { precision: 10, scale: 2 }).notNull(),
    // quantity × unitPrice — this participant's share of the pooled order.
    shareAmount: numeric("share_amount", { precision: 12, scale: 2 }).notNull(),
    // quantity × (baseUnitPrice − unitPrice) — savings versus buying solo.
    savingsAmount: numeric("savings_amount", { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("procurement_ledger_gb_tenant_uq").on(t.groupBuyId, t.tenantId),
    index("procurement_ledger_tenant_idx").on(t.tenantId),
  ]
);

export type ProcurementLedgerEntry = typeof procurementLedgerEntriesTable.$inferSelect;

// Per-merchant essential supply tracking: on-hand quantity plus a low-stock
// threshold. Dropping below the threshold surfaces a reorder reminder; when
// auto-request is enabled and the supply is linked to a vendor item, the
// worker starts (or joins) an open group buy for that item automatically.
export const procurementSupplyItemsTable = pgTable(
  "procurement_supply_items",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    unit: text("unit").notNull().default("unit"),
    onHandQty: integer("on_hand_qty").notNull().default(0),
    lowStockThreshold: integer("low_stock_threshold").notNull().default(0),
    // Optional link to a vendor's supply item — enables one-click / automatic
    // group-buy replenishment for this supply.
    vendorItemId: integer("vendor_item_id").references(() => procurementVendorItemsTable.id, {
      onDelete: "set null",
    }),
    // Auto-replenish: the worker creates or joins an open group buy when the
    // supply drops below its threshold (requires vendorItemId).
    autoRequestEnabled: boolean("auto_request_enabled").notNull().default(false),
    // Stamped when the low-stock sweep last reminded / auto-requested for this
    // item; cleared when the item is restocked to (or above) the threshold.
    lastReorderRemindedAt: timestamp("last_reorder_reminded_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("procurement_supply_items_tenant_idx").on(t.tenantId)]
);

export type ProcurementSupplyItem = typeof procurementSupplyItemsTable.$inferSelect;
