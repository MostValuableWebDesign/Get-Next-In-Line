import { pgTable, serial, text, numeric, integer, timestamp, boolean, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const agencySettingsTable = pgTable("agency_settings", {
  id: serial("id").primaryKey(),
  markupPercent: numeric("markup_percent", { precision: 5, scale: 2 }).notNull().default("35"),
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

export const tenantActivitiesTable = pgTable("tenant_activities", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  details: text("details"),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
});

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
  isActive: boolean("is_active").notNull().default(true),
  // Unique machine slug for the module (e.g. "ghl_crm_pipelines", "gusto").
  slug: text("slug").unique(),
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
