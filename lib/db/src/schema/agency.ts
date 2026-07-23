import { pgTable, serial, text, numeric, integer, timestamp, boolean, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const agencySettingsTable = pgTable("agency_settings", {
  id: serial("id").primaryKey(),
  markupPercent: numeric("markup_percent", { precision: 5, scale: 2 }).notNull().default("25"),
  platformName: text("platform_name").notNull().default("Get Next In Line"),
  deploymentMode: text("deployment_mode").notNull().default("Full-Stack Agency Mode"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAgencySettingsSchema = createInsertSchema(agencySettingsTable).omit({ id: true, updatedAt: true });
export type InsertAgencySettings = z.infer<typeof insertAgencySettingsSchema>;
export type AgencySettings = typeof agencySettingsTable.$inferSelect;

export const tenantsTable = pgTable("tenants", {
  id: serial("id").primaryKey(),
  brandName: text("brand_name").notNull(),
  subdomain: text("subdomain").notNull().unique(),
  status: text("status").notNull().default("active"), // active | suspended | pending
  mrr: numeric("mrr", { precision: 10, scale: 2 }).notNull().default("0"),
  modulesEnabled: integer("modules_enabled").notNull().default(0),
  contactEmail: text("contact_email"),
  contactName: text("contact_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTenantSchema = createInsertSchema(tenantsTable).omit({ id: true, createdAt: true });
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenantsTable.$inferSelect;

export const tenantActivitiesTable = pgTable(
  "tenant_activities",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    details: text("details"),
    timestamp: timestamp("timestamp").notNull().defaultNow(),
  },
  (table) => [
    // Supports GET /tenants/activity filtered by tenant, ordered by (timestamp desc, id desc)
    index("tenant_activities_tenant_id_timestamp_id_idx").on(table.tenantId, table.timestamp.desc(), table.id.desc()),
    // Supports the unfiltered activity feed ordered by (timestamp desc, id desc)
    index("tenant_activities_timestamp_id_idx").on(table.timestamp.desc(), table.id.desc()),
  ]
);

export const insertTenantActivitySchema = createInsertSchema(tenantActivitiesTable).omit({ id: true, timestamp: true });
export type InsertTenantActivity = z.infer<typeof insertTenantActivitySchema>;
export type TenantActivity = typeof tenantActivitiesTable.$inferSelect;

export const modulesTable = pgTable("modules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  categorySlug: text("category_slug").notNull(),
  description: text("description").notNull(),
  wholesalePrice: numeric("wholesale_price", { precision: 10, scale: 2 }).notNull(),
  // Optional bi-weekly wholesale rate — modules billed on a bi-weekly cadence
  // (not necessarily monthly/2). Null for monthly-only modules.
  wholesalePriceBiweekly: numeric("wholesale_price_biweekly", { precision: 10, scale: 2 }),
  isActive: boolean("is_active").notNull().default(true),
  // Unique machine slug for the module (e.g. "ghl_crm_pipelines", "gusto").
  slug: text("slug").unique(),
  // Customer-facing partner brand name — ONLY populated for partner-category
  // modules (deliberate, narrow exception to the white-label contract).
  // Null for all white-labeled modules; never derive from upstreamVendor.
  partnerBrand: text("partner_brand"),
  // Per-module markup override (percent). When set, pricing surfaces use this
  // instead of the agency-wide markup — e.g. 0 for partner-direct pass-through
  // modules, 25 for white-label resale engines. Null = agency-wide markup.
  markupPercentOverride: numeric("markup_percent_override", { precision: 5, scale: 2 }),
  // ── Hidden connector fields — ADMIN ONLY, never expose via tenant-facing APIs ──
  upstreamVendor: text("upstream_vendor"),
  hiddenConnector: text("hidden_connector"),
  proxyNotes: text("proxy_notes"),
});

export const insertModuleSchema = createInsertSchema(modulesTable).omit({ id: true });
export type InsertModule = z.infer<typeof insertModuleSchema>;
export type Module = typeof modulesTable.$inferSelect;

export const tenantModulesTable = pgTable(
  "tenant_modules",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    moduleId: integer("module_id")
      .notNull()
      .references(() => modulesTable.id, { onDelete: "cascade" }),
    // monthly | biweekly — cadence chosen at checkout time.
    billingCadence: text("billing_cadence").notNull().default("monthly"),
    // Realized per-charge pricing captured at checkout time (cadence-specific
    // amounts). Used for profit reporting so a checkout with markup disabled
    // is never reported as profitable. Null on legacy rows provisioned before
    // these columns existed — reporting falls back to the current markup.
    chargedWholesale: numeric("charged_wholesale", { precision: 10, scale: 2 }),
    chargedResale: numeric("charged_resale", { precision: 10, scale: 2 }),
    provisionedAt: timestamp("provisioned_at").notNull().defaultNow(),
  },
  (t) => [unique("tenant_modules_tenant_module_unique").on(t.tenantId, t.moduleId)]
);

export const insertTenantModuleSchema = createInsertSchema(tenantModulesTable).omit({
  id: true,
  provisionedAt: true,
});
export type InsertTenantModule = z.infer<typeof insertTenantModuleSchema>;
export type TenantModule = typeof tenantModulesTable.$inferSelect;
