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

// ── Marketing campaign redirect links ────────────────────────────────────────
// Trackable /r/:code links: each campaign belongs to a tenant; visiting the
// public redirect logs an attribution event and forwards to the tenant's
// public landing page.
export const campaignsTable = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  // Unique short code used in /r/:code URLs (lowercase [a-z0-9-]).
  code: text("code").notNull().unique(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  // Human-readable label, e.g. "Google Ads — Spring 2026".
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;

export const attributionEventsTable = pgTable(
  "attribution_events",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // Denormalized campaign code so events survive campaign edits and stay
    // queryable by the exact inbound URL.
    campaignCode: text("campaign_code").notNull(),
    eventType: text("event_type").notNull().default("click"),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    // Supports per-campaign click counts and recency queries.
    index("attribution_events_code_occurred_idx").on(t.campaignCode, t.occurredAt.desc()),
    index("attribution_events_tenant_idx").on(t.tenantId),
  ],
);

export const insertAttributionEventSchema = createInsertSchema(attributionEventsTable).omit({
  id: true,
  occurredAt: true,
});
export type InsertAttributionEvent = z.infer<typeof insertAttributionEventSchema>;
export type AttributionEvent = typeof attributionEventsTable.$inferSelect;

// ── Merchant co-op partnerships ──────────────────────────────────────────────
// Cross-promotion pacts between two businesses on the platform: a host tenant
// offers a perk (with a redemption code) to customers referred from a partner
// tenant. Pairing two tenants in the same module category is blocked (the
// "industry barrier") unless an admin explicitly overrides it — tenants must
// never boost a direct competitor.
export const merchantCoopPartnershipsTable = pgTable(
  "merchant_coop_partnerships",
  {
    id: serial("id").primaryKey(),
    hostTenantId: integer("host_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    partnerTenantId: integer("partner_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    perkTitle: text("perk_title").notNull(),
    perkDescription: text("perk_description"),
    // Unique across all partnerships; auto-generated when not supplied.
    redemptionCode: text("redemption_code").notNull().unique(),
    // True when an admin explicitly bypassed the same-category block.
    industryBarrierOverridden: boolean("industry_barrier_overridden").notNull().default(false),
    // Invite lifecycle: pending | accepted | declined. Admin-created rows
    // (and all pre-existing rows) default to accepted so nothing regresses;
    // merchant-initiated invites start pending and only go live on accept.
    status: text("status").notNull().default("accepted"),
    // Tenant that initiated the invite (NULL for admin-created partnerships).
    requestedByTenantId: integer("requested_by_tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    // Free-form description of what each side owes the other (mutual terms).
    mutualRewardTerms: text("mutual_reward_terms"),
    // Optional perk availability window. NULL = always active on that side.
    // Outside the window the perk never appears on customer-facing surfaces
    // and its redemption code fails validation.
    perkStartsAt: timestamp("perk_starts_at"),
    perkEndsAt: timestamp("perk_ends_at"),
    respondedAt: timestamp("responded_at"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("merchant_coop_partnerships_host_idx").on(t.hostTenantId),
    index("merchant_coop_partnerships_partner_idx").on(t.partnerTenantId),
  ]
);

// ── Platform invitations ─────────────────────────────────────────────────────
// A merchant invites an OFF-platform business to join Get Next In Line via a
// unique trackable link. When the external owner registers through the link,
// a pending co-op partnership from the inviter to the new tenant is created
// automatically.
export const platformInvitesTable = pgTable(
  "platform_invites",
  {
    id: serial("id").primaryKey(),
    inviterTenantId: integer("inviter_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    invitedBusinessName: text("invited_business_name").notNull(),
    // Free-form contact hint (phone/email) the merchant noted; optional.
    invitedContact: text("invited_contact"),
    // Unique single-use token embedded in the trackable link.
    token: text("token").notNull().unique(),
    // Lifecycle: sent → clicked → registered; expired when past expires_at.
    status: text("status").notNull().default("sent"),
    // Tenant created through this invite, once registered.
    resultingTenantId: integer("resulting_tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at").notNull(),
    clickedAt: timestamp("clicked_at"),
    registeredAt: timestamp("registered_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("platform_invites_inviter_idx").on(t.inviterTenantId)]
);

export const insertPlatformInviteSchema = createInsertSchema(platformInvitesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPlatformInvite = z.infer<typeof insertPlatformInviteSchema>;
export type PlatformInvite = typeof platformInvitesTable.$inferSelect;

export const insertMerchantCoopPartnershipSchema = createInsertSchema(
  merchantCoopPartnershipsTable
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMerchantCoopPartnership = z.infer<typeof insertMerchantCoopPartnershipSchema>;
export type MerchantCoopPartnership = typeof merchantCoopPartnershipsTable.$inferSelect;

// ── Co-op perk redemptions ───────────────────────────────────────────────────
// One row per redeemed pass/code instance. The unique (partnership, passCode)
// pair is the double-redemption lock: a second scan of the same customer's
// pass hits the constraint and is rejected as already redeemed, even under
// concurrent double-scans.
export const coopPerkRedemptionsTable = pgTable(
  "coop_perk_redemptions",
  {
    id: serial("id").primaryKey(),
    partnershipId: integer("partnership_id")
      .notNull()
      .references(() => merchantCoopPartnershipsTable.id, { onDelete: "cascade" }),
    // Identifies the specific customer pass instance (e.g. "C123" from the
    // pass QR payload). Locked per partnership once redeemed.
    passCode: text("pass_code").notNull(),
    // Tenant whose staff scanned/redeemed the perk (NULL if tenant deleted).
    redeemedByTenantId: integer("redeemed_by_tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    redeemedAt: timestamp("redeemed_at").notNull().defaultNow(),
  },
  (t) => [unique("coop_perk_redemptions_partnership_pass_uq").on(t.partnershipId, t.passCode)]
);

export type CoopPerkRedemption = typeof coopPerkRedemptionsTable.$inferSelect;

export const insertTenantModuleSchema = createInsertSchema(tenantModulesTable).omit({
  id: true,
  provisionedAt: true,
});
export type InsertTenantModule = z.infer<typeof insertTenantModuleSchema>;
export type TenantModule = typeof tenantModulesTable.$inferSelect;
