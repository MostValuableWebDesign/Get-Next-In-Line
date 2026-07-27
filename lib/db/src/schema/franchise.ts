import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { tenantsTable, merchantCoopPartnershipsTable } from "./agency";
import { usersTable } from "./users";

// ── Franchise co-op organizations ────────────────────────────────────────────
// Multi-Location & Enterprise Franchise Co-Op Controller: an organization
// groups existing tenants (storefronts) into a hierarchy (HQ → region →
// storefront). HQ pushes global perk templates down to every attached
// storefront, sets the local-autonomy policy, and gets consolidated roll-up
// reporting. Tenants NOT in any organization are completely unaffected.
export const franchiseOrgsTable = pgTable("franchise_orgs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // Local-autonomy policy for storefront-initiated partnerships:
  // allowed | approval_required | locked
  autonomyPolicy: text("autonomy_policy").notNull().default("allowed"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FranchiseOrg = typeof franchiseOrgsTable.$inferSelect;

// Regions group storefronts under an org (the middle hierarchy tier).
export const franchiseRegionsTable = pgTable(
  "franchise_regions",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => franchiseOrgsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("franchise_regions_org_name_uq").on(t.orgId, t.name),
    index("franchise_regions_org_idx").on(t.orgId),
  ],
);

export type FranchiseRegion = typeof franchiseRegionsTable.$inferSelect;

// A storefront = an existing tenant attached to an org (optionally grouped
// into a region). A tenant can belong to at most ONE org — cross-org
// membership would leak perks across franchises.
export const franchiseStorefrontsTable = pgTable(
  "franchise_storefronts",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => franchiseOrgsTable.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .unique("franchise_storefronts_tenant_uq")
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    regionId: integer("region_id").references(() => franchiseRegionsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("franchise_storefronts_org_idx").on(t.orgId)],
);

export type FranchiseStorefront = typeof franchiseStorefrontsTable.$inferSelect;

// Hierarchy roles, scoped strictly to this module's org scope (NOT a
// platform-wide RBAC): super_admin (whole org), regional_manager (one
// region's storefronts), storefront_operator (one location).
export const franchiseRolesTable = pgTable(
  "franchise_roles",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => franchiseOrgsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // super_admin | regional_manager | storefront_operator
    role: text("role").notNull(),
    // Required for regional_manager (their region), NULL otherwise.
    regionId: integer("region_id").references(() => franchiseRegionsTable.id, {
      onDelete: "cascade",
    }),
    // Required for storefront_operator (their location), NULL otherwise.
    tenantId: integer("tenant_id").references(() => tenantsTable.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("franchise_roles_org_user_uq").on(t.orgId, t.userId),
    index("franchise_roles_user_idx").on(t.userId),
  ],
);

export type FranchiseRole = typeof franchiseRolesTable.$inferSelect;

// Global perk templates defined by HQ. Deploying fans out one live co-op
// perk (a self-scoped merchant_coop_partnerships row) per attached
// storefront; updates/retirements propagate to every derived perk.
export const franchisePerkTemplatesTable = pgTable(
  "franchise_perk_templates",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => franchiseOrgsTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    redemptionTerms: text("redemption_terms"),
    // active | retired
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("franchise_perk_templates_org_idx").on(t.orgId)],
);

export type FranchisePerkTemplate = typeof franchisePerkTemplatesTable.$inferSelect;

// One deployment row per (template, storefront) — the idempotency lock for
// the propagation engine, plus the per-location deployment status surface.
export const franchiseTemplateDeploymentsTable = pgTable(
  "franchise_template_deployments",
  {
    id: serial("id").primaryKey(),
    templateId: integer("template_id")
      .notNull()
      .references(() => franchisePerkTemplatesTable.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // The live co-op perk record derived from the template at this location.
    partnershipId: integer("partnership_id").references(
      () => merchantCoopPartnershipsTable.id,
      { onDelete: "set null" },
    ),
    // deployed | retired
    status: text("status").notNull().default("deployed"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("franchise_template_deployments_uq").on(t.templateId, t.tenantId),
    index("franchise_template_deployments_tenant_idx").on(t.tenantId),
  ],
);

export type FranchiseTemplateDeployment =
  typeof franchiseTemplateDeploymentsTable.$inferSelect;

// Approval queue for storefront-initiated local partnerships under the
// approval_required autonomy policy. Approved requests materialize a normal
// pending co-op invite through the existing (unchanged) invite lifecycle.
export const franchisePartnershipRequestsTable = pgTable(
  "franchise_partnership_requests",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => franchiseOrgsTable.id, { onDelete: "cascade" }),
    storefrontTenantId: integer("storefront_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    targetTenantId: integer("target_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    perkTitle: text("perk_title").notNull(),
    perkDescription: text("perk_description"),
    // pending | approved | rejected
    status: text("status").notNull().default("pending"),
    requestedByUserId: integer("requested_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    decidedByUserId: integer("decided_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at"),
    // Invite created on approval (or immediately under the allowed policy).
    partnershipId: integer("partnership_id").references(
      () => merchantCoopPartnershipsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("franchise_partnership_requests_org_idx").on(t.orgId)],
);

export type FranchisePartnershipRequest =
  typeof franchisePartnershipRequestsTable.$inferSelect;
