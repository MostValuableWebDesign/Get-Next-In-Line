import { pgTable, serial, text, numeric, integer, timestamp, boolean, unique, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
    // Set by the dispute engine when an unresolved dispute passed its grace
    // deadline: the perk stops being served and the partnership is hidden
    // from discovery until an admin reinstates it. Independent of isActive
    // so reinstating restores the merchant's own on/off choice.
    disputeSuspended: boolean("dispute_suspended").notNull().default(false),
    // Set when a platform admin permanently bans the partnership. A banned
    // partnership never serves its perk again.
    bannedAt: timestamp("banned_at"),
    // Direction-aware cross-promotion tracking codes (unguessable, unique
    // across all partnerships). hostTrackingCode is carried by the HOST's
    // customers and redeemed at the partner (host→partner traffic);
    // partnerTrackingCode is the mirror direction. NULL only transiently —
    // backfilled at server start for pre-existing rows.
    hostTrackingCode: text("host_tracking_code").unique(),
    partnerTrackingCode: text("partner_tracking_code").unique(),
    // Performance-based partnership tier: "premier" | "standard". Evaluated by
    // the scheduled tier job against rolling 30-day attribution counts.
    tier: text("tier").notNull().default("standard"),
    // Reciprocity thresholds (customers / rolling 30 days) each side demands
    // of the OTHER side's traffic. hostReciprocityThreshold is set by the host
    // and applies to partner→host traffic; partnerReciprocityThreshold is the
    // mirror. NULL = platform default applies.
    hostReciprocityThreshold: integer("host_reciprocity_threshold"),
    partnerReciprocityThreshold: integer("partner_reciprocity_threshold"),
    // Set by the tier evaluator when the partnership had ZERO cross-promoted
    // traffic over the rolling 30-day window: the perk stops being served on
    // every customer surface until traffic resumes or both parties agree to
    // reactivate. Independent of isActive/disputeSuspended so clearing it
    // restores the merchants' own on/off choice.
    performancePausedAt: timestamp("performance_paused_at"),
    // One-sided reactivation request while performance-paused; when the OTHER
    // party also requests, the pause clears (mutual agreement).
    reactivationRequestedByTenantId: integer("reactivation_requested_by_tenant_id").references(
      () => tenantsTable.id,
      { onDelete: "set null" }
    ),
    // ── Pending re-negotiation proposal ─────────────────────────────────────
    // One participant proposes revised perk/mutual terms; they only replace
    // the live fields when the other side accepts. All NULL when no proposal
    // is pending.
    proposedPerkTitle: text("proposed_perk_title"),
    proposedPerkDescription: text("proposed_perk_description"),
    proposedMutualRewardTerms: text("proposed_mutual_reward_terms"),
    renegotiationRequestedByTenantId: integer("renegotiation_requested_by_tenant_id").references(
      () => tenantsTable.id,
      { onDelete: "set null" }
    ),
    renegotiationRequestedAt: timestamp("renegotiation_requested_at"),
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

// ── Co-op isolation pairs ────────────────────────────────────────────────────
// Mutual competitor-isolation records produced by the automated conflict
// check: when two businesses share the same Level 2 sub-category within
// overlapping co-op radii, a pair is persisted (tenantAId < tenantBId).
// Discovery, recommendations, and consumer perk surfaces honor the pair even
// if radii or locations are later edited; it only stops applying when the two
// businesses' sub-categories diverge.
export const coopIsolationPairsTable = pgTable(
  "coop_isolation_pairs",
  {
    id: serial("id").primaryKey(),
    tenantAId: integer("tenant_a_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    tenantBId: integer("tenant_b_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // Sub-category key both sides shared when the pair was recorded.
    subCategory: text("sub_category").notNull(),
    // How the overlap was established: radius | city
    matchBasis: text("match_basis").notNull().default("radius"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("coop_isolation_pairs_pair_uq").on(t.tenantAId, t.tenantBId),
    index("coop_isolation_pairs_a_idx").on(t.tenantAId),
    index("coop_isolation_pairs_b_idx").on(t.tenantBId),
  ]
);

export type CoopIsolationPair = typeof coopIsolationPairsTable.$inferSelect;

// ── Co-op partner suggestions (matchmaking engine) ───────────────────────────
// Persisted "Suggested Partners" feed rows, computed automatically when a
// business completes setup (and refreshed when its category/location change).
// Scoring uses only signals already in the platform: category complementarity,
// proximity, and activity (bookings/customers). Same-sub-category competitors,
// existing/pending partners, and dismissed businesses are never stored — and
// are filtered again at read time so stale rows can never leak through.
export const coopSuggestionsTable = pgTable(
  "coop_suggestions",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    suggestedTenantId: integer("suggested_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // Complementary-fit score (higher = better match), 0-100.
    score: integer("score").notNull().default(0),
    // Human-readable match reasons shown on the suggestion card.
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    computedAt: timestamp("computed_at").notNull().defaultNow(),
  },
  (t) => [
    unique("coop_suggestions_tenant_suggested_uq").on(t.tenantId, t.suggestedTenantId),
    index("coop_suggestions_tenant_idx").on(t.tenantId),
  ]
);

export type CoopSuggestion = typeof coopSuggestionsTable.$inferSelect;

// ── Co-op suggestion dismissals ──────────────────────────────────────────────
// A merchant dismissed a suggested partner: the pair stays hidden from the
// suggestions feed permanently (until they partner through another path).
export const coopSuggestionDismissalsTable = pgTable(
  "coop_suggestion_dismissals",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    dismissedTenantId: integer("dismissed_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("coop_suggestion_dismissals_pair_uq").on(t.tenantId, t.dismissedTenantId),
    index("coop_suggestion_dismissals_tenant_idx").on(t.tenantId),
  ]
);

export type CoopSuggestionDismissal = typeof coopSuggestionDismissalsTable.$inferSelect;
// ── Co-op analytics events ───────────────────────────────────────────────────
// Tenant-scoped tracking of what the co-op network actually does for each
// business: perk impressions (perk blocks shown on checkout tickets, receipts,
// passes, and public landing pages), claims (redemption code validated at
// checkout), and cross-over visits (a partner's customer showing up at the
// host business). `tenantId` is the business the event happened AT; the other
// side of the partnership is `partnerTenantId`. Crossover events may carry the
// checkout revenue captured for the revenue-influenced estimate.
export const coopEventsTable = pgTable(
  "coop_events",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    partnershipId: integer("partnership_id")
      .notNull()
      .references(() => merchantCoopPartnershipsTable.id, { onDelete: "cascade" }),
    partnerTenantId: integer("partner_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // impression | claim | crossover
    eventType: text("event_type").notNull(),
    // Checkout revenue attributed to a crossover visit (NULL until attributed,
    // and always NULL for impression/claim events).
    revenueAmount: numeric("revenue_amount", { precision: 12, scale: 2 }),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    // Per-tenant aggregation over a date range, by type.
    index("coop_events_tenant_type_occurred_idx").on(t.tenantId, t.eventType, t.occurredAt.desc()),
    // Per-partnership breakdown rows.
    index("coop_events_partnership_idx").on(t.partnershipId),
  ],
);

export const insertCoopEventSchema = createInsertSchema(coopEventsTable).omit({
  id: true,
  occurredAt: true,
});
export type InsertCoopEvent = z.infer<typeof insertCoopEventSchema>;
export type CoopEvent = typeof coopEventsTable.$inferSelect;

// ── Co-op monthly impact reports ─────────────────────────────────────────────
// One persisted row per tenant per calendar month (month key "YYYY-MM"),
// generated by the scheduled worker after the month closes. The unique
// (tenant, month) pair is the idempotency lock: re-running the job can never
// produce duplicate reports (or duplicate notifications — the notification is
// only sent when the insert actually created the row).
export const coopMonthlyReportsTable = pgTable(
  "coop_monthly_reports",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // Calendar month key, e.g. "2026-06".
    month: text("month").notNull(),
    impressions: integer("impressions").notNull().default(0),
    claims: integer("claims").notNull().default(0),
    crossoverVisits: integer("crossover_visits").notNull().default(0),
    revenueInfluenced: numeric("revenue_influenced", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique("coop_monthly_reports_tenant_month_uq").on(t.tenantId, t.month)],
);

export type CoopMonthlyReport = typeof coopMonthlyReportsTable.$inferSelect;
// ── Co-op partnership disputes ───────────────────────────────────────────────
// A merchant flags a problem partner on an active partnership. The platform
// mediates automatically: a grace period (7 business days) runs first; if the
// dispute is still open when it expires, the background worker escalates it —
// pausing the shared perk and hiding the partnership — until a platform admin
// reinstates, bans, or mediates. Every state change is timestamped so the
// history of a dispute is auditable.
export const coopDisputesTable = pgTable(
  "coop_disputes",
  {
    id: serial("id").primaryKey(),
    partnershipId: integer("partnership_id")
      .notNull()
      .references(() => merchantCoopPartnershipsTable.id, { onDelete: "cascade" }),
    // The business that filed the dispute and the partner being reported —
    // always the two parties of the partnership.
    reportingTenantId: integer("reporting_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    reportedTenantId: integer("reported_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // Standardized dispute category (see COOP_DISPUTE_CATEGORIES in the API).
    category: text("category").notNull(),
    details: text("details"),
    // open → escalated → resolved | withdrawn | banned.
    status: text("status").notNull().default("open"),
    // End of the 7-business-day resolution window computed at filing time.
    graceDeadlineAt: timestamp("grace_deadline_at").notNull(),
    escalatedAt: timestamp("escalated_at"),
    resolvedAt: timestamp("resolved_at"),
    withdrawnAt: timestamp("withdrawn_at"),
    // Append-only mediation log kept by platform admins (timestamped lines).
    mediationNotes: text("mediation_notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("coop_disputes_partnership_idx").on(t.partnershipId),
    index("coop_disputes_status_idx").on(t.status),
    // DB-enforced invariant: at most one live (open/escalated) dispute per
    // partnership, even under concurrent filings.
    uniqueIndex("coop_disputes_one_live_per_partnership_idx")
      .on(t.partnershipId)
      .where(sql`status in ('open', 'escalated')`),
  ]
);

// ── Co-op promotional campaigns (seasonal flash blasts) ──────────────────────
// A merchant with at least one accepted, active partnership launches a
// synchronized limited-time flash campaign: a uniform start/end window that
// applies identically to every participating partner, plus a boosted perk
// description shown on each participant's co-op perks surface only while the
// window is open. The creator can trigger (or the worker auto-fires at start)
// one joint SMS blast to every joined participant's opted-in customers.
export const coopCampaignsTable = pgTable(
  "coop_campaigns",
  {
    id: serial("id").primaryKey(),
    creatorTenantId: integer("creator_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // Preset template slug (back_to_school | holiday_weekend | community_event
    // | custom). Presentation + defaults only; the window below is canonical.
    template: text("template").notNull().default("custom"),
    name: text("name").notNull(),
    // The boosted flash-offer text shown on every participant's perk surface.
    perkBoostText: text("perk_boost_text").notNull(),
    // Uniform campaign window — identical for every participant by design.
    startsAt: timestamp("starts_at").notNull(),
    endsAt: timestamp("ends_at").notNull(),
    // Stamped when the joint blast fires (manually or by the worker at
    // campaign start). The conditional `IS NULL` claim on this column is the
    // send-once lock: the network blast can never double-fire.
    blastTriggeredAt: timestamp("blast_triggered_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("coop_campaigns_creator_idx").on(t.creatorTenantId),
    // Worker sweep: due campaigns with an unfired blast.
    index("coop_campaigns_blast_due_idx").on(t.startsAt).where(sql`blast_triggered_at is null`),
  ],
);

export type CoopCampaign = typeof coopCampaignsTable.$inferSelect;

// Per-partner participation: invited partners join or decline; the campaign
// only goes live (perk boost + blast inclusion) for tenants who joined. The
// creator's own row is created as "joined".
export const coopCampaignParticipantsTable = pgTable(
  "coop_campaign_participants",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => coopCampaignsTable.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // invited | joined | declined
    status: text("status").notNull().default("invited"),
    respondedAt: timestamp("responded_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("coop_campaign_participants_campaign_tenant_uq").on(t.campaignId, t.tenantId),
    index("coop_campaign_participants_tenant_idx").on(t.tenantId),
  ],
);

export type CoopCampaignParticipant = typeof coopCampaignParticipantsTable.$inferSelect;

// Blast log — one row per customer send, keyed by normalized phone. This is
// the frequency-cap ledger: a phone that appears here within the rolling
// 7-day window (from ANY campaign across the network) is skipped by every
// subsequent campaign blast, so shared local customers are never spammed.
export const coopCampaignBlastsTable = pgTable(
  "coop_campaign_blasts",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => coopCampaignsTable.id, { onDelete: "cascade" }),
    // Participating merchant whose customer list this send came from.
    tenantId: integer("tenant_id").references(() => tenantsTable.id, { onDelete: "set null" }),
    customerId: integer("customer_id"),
    // Normalized E.164 recipient — the frequency-cap key.
    phone: text("phone").notNull(),
    sentAt: timestamp("sent_at").notNull().defaultNow(),
  },
  (t) => [
    index("coop_campaign_blasts_phone_sent_idx").on(t.phone, t.sentAt.desc()),
    index("coop_campaign_blasts_campaign_idx").on(t.campaignId),
  ],
);

export type CoopCampaignBlast = typeof coopCampaignBlastsTable.$inferSelect;

export const insertCoopDisputeSchema = createInsertSchema(coopDisputesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCoopDispute = z.infer<typeof insertCoopDisputeSchema>;
export type CoopDispute = typeof coopDisputesTable.$inferSelect;

// ── Platform compliance ledger ───────────────────────────────────────────────
// Append-only ledger of every money-relevant platform event: module
// subscription charges (realized wholesale/resale captured at checkout),
// visit checkouts, plan purchases/renewals, and deposit-hold outcomes.
// Rows are NEVER updated or deleted (a DB trigger enforces this) so
// compliance figures are reproducible instead of recomputed per screen.
// The unique (source, source_ref) pair makes capture + backfill idempotent.
export const platformLedgerEntriesTable = pgTable(
  "platform_ledger_entries",
  {
    id: serial("id").primaryKey(),
    // Event family: module_subscription | visit_checkout | plan_purchase |
    // plan_renewal | deposit_captured | deposit_released | deposit_failed
    source: text("source").notNull(),
    // Stable reference to the originating row, e.g. "tenant_modules:12".
    sourceRef: text("source_ref").notNull(),
    // NULL = legacy (pre-tenant) SOS rows; kept nullable so those still land.
    tenantId: integer("tenant_id").references(() => tenantsTable.id, { onDelete: "set null" }),
    // Reporting bucket: module category for subscriptions; "Visits",
    // "Plans", "Deposits" for operational money events.
    category: text("category").notNull(),
    description: text("description"),
    // Money moved by the event (resale charge, visit payment, captured fee).
    // 0.00 for outcome-only events (released/failed deposits).
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    // Realized wholesale cost for module subscription charges; NULL elsewhere.
    wholesaleAmount: numeric("wholesale_amount", { precision: 12, scale: 2 }),
    // Platform's realized margin on the event. Always 0 for partner
    // pass-through subscriptions and tenant-revenue events.
    platformMargin: numeric("platform_margin", { precision: 12, scale: 2 }).notNull().default("0"),
    // When the underlying money event happened (checkout, resolution, etc.).
    occurredAt: timestamp("occurred_at").notNull(),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (t) => [
    unique("platform_ledger_source_ref_uq").on(t.source, t.sourceRef),
    index("platform_ledger_occurred_idx").on(t.occurredAt.desc()),
    index("platform_ledger_tenant_idx").on(t.tenantId),
  ],
);

export const insertPlatformLedgerEntrySchema = createInsertSchema(platformLedgerEntriesTable).omit({
  id: true,
  recordedAt: true,
});
export type InsertPlatformLedgerEntry = z.infer<typeof insertPlatformLedgerEntrySchema>;
export type PlatformLedgerEntry = typeof platformLedgerEntriesTable.$inferSelect;

// ── Co-op cross-promotion attribution events ─────────────────────────────────
// One row per *counted* redemption, attributing cross-promotion traffic to a
// partnership direction: the sending tenant referred the customer, the
// receiving tenant honored the perk. The unique redemption_id FK is the
// exactly-once guarantee — an event can only exist for a redemption that
// won the (partnership, passCode) lock, so refreshes/replays never double
// count.
export const coopAttributionEventsTable = pgTable(
  "coop_attribution_events",
  {
    id: serial("id").primaryKey(),
    redemptionId: integer("redemption_id")
      .notNull()
      .unique()
      .references(() => coopPerkRedemptionsTable.id, { onDelete: "cascade" }),
    partnershipId: integer("partnership_id")
      .notNull()
      .references(() => merchantCoopPartnershipsTable.id, { onDelete: "cascade" }),
    // "host_to_partner": host's customer redeemed at the partner.
    // "partner_to_host": partner's customer redeemed at the host.
    direction: text("direction").notNull(),
    sendingTenantId: integer("sending_tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    receivingTenantId: integer("receiving_tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    index("coop_attribution_events_partnership_idx").on(t.partnershipId),
    index("coop_attribution_events_sending_idx").on(t.sendingTenantId),
    index("coop_attribution_events_receiving_idx").on(t.receivingTenantId),
    index("coop_attribution_events_occurred_idx").on(t.occurredAt),
  ]
);

export type CoopAttributionEvent = typeof coopAttributionEventsTable.$inferSelect;

// ── Co-op plaza exclusivity conflicts ────────────────────────────────────────
// Recorded whenever the plaza exclusivity rule blocks a partnership invite:
// two businesses in the same commercial complex (matching street address
// block + postal code, or lat/long proximity) can't both pair with the same
// anchor business's category. One row per blocked (requester, blocked
// partner, category) trio; both tenants see the conflict as an in-app
// notification, and an admin can release the exclusivity to let a retried
// invite through. Admin-only release — never tenant-facing.
export const coopPlazaConflictsTable = pgTable(
  "coop_plaza_conflicts",
  {
    id: serial("id").primaryKey(),
    // Tenant whose invite was blocked.
    requesterTenantId: integer("requester_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // Tenant the requester tried to invite.
    blockedPartnerTenantId: integer("blocked_partner_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // Requester's existing same-plaza partnership that already holds the
    // category (NULL if that partnership was later deleted).
    existingPartnershipId: integer("existing_partnership_id").references(
      () => merchantCoopPartnershipsTable.id,
      { onDelete: "set null" }
    ),
    // Normalized industry category the exclusivity applies to.
    category: text("category").notNull(),
    // active — exclusivity holds; released — admin lifted it (invites allowed).
    status: text("status").notNull().default("active"),
    releasedAt: timestamp("released_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("coop_plaza_conflicts_requester_idx").on(t.requesterTenantId),
    index("coop_plaza_conflicts_blocked_idx").on(t.blockedPartnerTenantId),
    // One conflict row per trio — repeat blocked attempts update the row.
    unique("coop_plaza_conflicts_trio_uq").on(
      t.requesterTenantId,
      t.blockedPartnerTenantId,
      t.category
    ),
  ]
);

export type CoopPlazaConflict = typeof coopPlazaConflictsTable.$inferSelect;

// ── Co-op partnership tier events ────────────────────────────────────────────
// Append-style audit trail of every automatic or mutual tier transition the
// performance evaluator (or the reactivation flow) applied: what changed,
// why, and the rolling 30-day attribution counts that drove the decision.
export const coopTierEventsTable = pgTable(
  "coop_tier_events",
  {
    id: serial("id").primaryKey(),
    partnershipId: integer("partnership_id")
      .notNull()
      .references(() => merchantCoopPartnershipsTable.id, { onDelete: "cascade" }),
    // Tier/pause state before and after ("premier" | "standard" | "paused").
    previousState: text("previous_state").notNull(),
    newState: text("new_state").notNull(),
    // Human-readable explanation shown in notifications and audits.
    reason: text("reason").notNull(),
    // Rolling 30-day attribution counts at evaluation time.
    hostToPartnerCount: integer("host_to_partner_count").notNull().default(0),
    partnerToHostCount: integer("partner_to_host_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("coop_tier_events_partnership_idx").on(t.partnershipId, t.createdAt.desc())]
);

export type CoopTierEvent = typeof coopTierEventsTable.$inferSelect;
// ── Co-op cross-promotion traffic events ─────────────────────────────────────
// One row per cross-promotion traffic event, keyed to a partnership. The
// receiving tenant is the party the traffic/benefit flowed toward; the source
// tenant is the party on whose surface the event originated (landing page
// owner, validating business). For a given tenant, inbound = events where it
// is the receiver, outbound = events where the other party is. No NULL-tenant
// legacy rows here — every event is strictly attributed.
export const coopTrafficEventsTable = pgTable(
  "coop_traffic_events",
  {
    id: serial("id").primaryKey(),
    partnershipId: integer("partnership_id")
      .notNull()
      .references(() => merchantCoopPartnershipsTable.id, { onDelete: "cascade" }),
    receivingTenantId: integer("receiving_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    sourceTenantId: integer("source_tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    // perk_impression | perk_click | code_validation
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    // Supports per-partnership windowed inbound/outbound counts.
    index("coop_traffic_events_partnership_occurred_idx").on(t.partnershipId, t.occurredAt.desc()),
    index("coop_traffic_events_receiving_tenant_idx").on(t.receivingTenantId),
  ]
);

export const insertCoopTrafficEventSchema = createInsertSchema(coopTrafficEventsTable).omit({
  id: true,
  occurredAt: true,
});
export type InsertCoopTrafficEvent = z.infer<typeof insertCoopTrafficEventSchema>;
export type CoopTrafficEvent = typeof coopTrafficEventsTable.$inferSelect;

export const insertTenantModuleSchema = createInsertSchema(tenantModulesTable).omit({
  id: true,
  provisionedAt: true,
});
export type InsertTenantModule = z.infer<typeof insertTenantModuleSchema>;
export type TenantModule = typeof tenantModulesTable.$inferSelect;
