import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
  jsonb,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { clientProfilesTable } from "./concierge";
import { tenantsTable, merchantCoopPartnershipsTable } from "./agency";

// SOS operations platform tables (separate product from GNIL OS agency tables)

export const sosSettingsTable = pgTable("sos_settings", {
  id: serial("id").primaryKey(),
  // Tenant scope for the settings row. NULL identifies the legacy global
  // (single-tenant) record that /sos/settings reads and writes; each tenant
  // gets its own row, auto-created on first access.
  tenantId: integer("tenant_id")
    .unique()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  businessName: text("business_name").notNull().default("SOS Operations"),
  industryType: text("industry_type").notNull().default("salon"),
  resourceLabel: text("resource_label").notNull().default("Chair"),
  // Daily business hours ("HH:MM", 24h) used by the public booking page to
  // compute offerable slots. Single open/close window applied to every day.
  openTime: text("open_time").notNull().default("09:00"),
  closeTime: text("close_time").notNull().default("17:00"),
  // Comma-separated list of the business's own service names (e.g. "haircut, color").
  serviceNames: text("service_names").notNull().default(""),
  aiReceptionistEnabled: boolean("ai_receptionist_enabled").notNull().default(true),
  waitlistAutoFillEnabled: boolean("waitlist_auto_fill_enabled").notNull().default(true),
  smsFromNumber: text("sms_from_number"),
  // ── No-Show Shield & Deposits policy ──────────────────────────────────────
  // Only enforced when the no_show_shield module is provisioned AND this flag
  // is on. Amounts are simulated card-on-file holds (no real payments).
  noShowShieldEnabled: boolean("no_show_shield_enabled").notNull().default(false),
  noShowDepositAmount: numeric("no_show_deposit_amount", { precision: 10, scale: 2 })
    .notNull()
    .default("25.00"),
  // Cancellations at least this many hours before the start release the hold;
  // later cancellations (or no-shows) capture the fee.
  noShowCancellationWindowHours: integer("no_show_cancellation_window_hours")
    .notNull()
    .default(24),
  noShowFee: numeric("no_show_fee", { precision: 10, scale: 2 })
    .notNull()
    .default("25.00"),
  // Fallback visit cycle (days) used by the rebooking-nudge scan for clients
  // whose visit history is too thin to compute a personal average.
  defaultCycleDays: integer("default_cycle_days").notNull().default(30),
  // ── Local SEO / public landing page profile ────────────────────────────────
  // Fields backing the per-business SEO landing page and its Schema.org
  // LocalBusiness JSON-LD. All optional — the landing page renders whatever
  // is filled in and omits the rest from the markup.
  seoDescription: text("seo_description").notNull().default(""),
  // Public-facing phone number (distinct from the SMS sending number).
  publicPhone: text("public_phone").notNull().default(""),
  streetAddress: text("street_address").notNull().default(""),
  addressLocality: text("address_locality").notNull().default(""), // city
  addressRegion: text("address_region").notNull().default(""), // state/province
  postalCode: text("postal_code").notNull().default(""),
  // Stored as text to avoid float drift; validated as decimal strings.
  latitude: text("latitude").notNull().default(""),
  longitude: text("longitude").notNull().default(""),
  // Schema.org LocalBusiness subtype (e.g. "HairSalon", "AutoRepair").
  businessCategory: text("business_category").notNull().default(""),
  // ── Co-op firewall & proximity ─────────────────────────────────────────────
  // Level 2 sub-category key from the curated co-op taxonomy (e.g.
  // "barbershop", "mechanic-shop"). Empty = auto-derived from
  // businessCategory/industryType via the taxonomy keyword mapping.
  coopSubCategory: text("coop_sub_category").notNull().default(""),
  // Co-op local discovery radius in miles (1–15). Every business gets the
  // smart default automatically at onboarding; owners adjust via a slider.
  coopRadiusMiles: integer("coop_radius_miles").notNull().default(4),
  // ── Co-op geographic radius ────────────────────────────────────────────────
  // How lat/lng were set: "" (unset), "manual" (typed by the merchant — never
  // overwritten by auto-detection) or "auto" (geocoded from the address).
  coordinatesSource: text("coordinates_source").notNull().default(""),
  // ── Marketing branding assets ──────────────────────────────────────────────
  // Logo stored as a data URL (client-side resized before upload; empty when
  // unset) plus brand colors, used by the co-op Marketing Hub asset generator.
  brandLogoUrl: text("brand_logo_url").notNull().default(""),
  brandPrimaryColor: text("brand_primary_color").notNull().default(""),
  brandSecondaryColor: text("brand_secondary_color").notNull().default(""),
  // Auto-detected commercial density around the address: dense_urban |
  // suburban | rural. Suburban is the documented fallback when the address is
  // missing or geocoding/POI lookup fails.
  densityClassification: text("density_classification").notNull().default("suburban"),
  // Auto-assigned co-op cross-promotion radius (miles) from the density
  // classification. Suburban default until detection runs.
  coopRadiusAutoMiles: numeric("coop_radius_auto_miles", { precision: 5, scale: 1 })
    .notNull()
    .default("4.0"),
  // Merchant override (miles). NULL = automatic. Once set, automatic
  // re-detection never clobbers it; the effective radius is override ?? auto.
  coopRadiusOverrideMiles: numeric("coop_radius_override_miles", { precision: 5, scale: 1 }),
  // ── Co-op reciprocity threshold ────────────────────────────────────────────
  // Optional flagging of lopsided co-op partnerships in the Partner Hub.
  // Margin NULL = flagging off. A partnership is flagged when the traffic
  // disparity (|in − out| / max(in, out) × 100) over the evaluation window
  // exceeds the margin.
  coopReciprocityMarginPercent: integer("coop_reciprocity_margin_percent"),
  coopReciprocityWindowDays: integer("coop_reciprocity_window_days").notNull().default(30),
  // ── Co-op surge pricing / capacity broadcasting ───────────────────────────
  // Daily appointment capacity threshold used by the automatic capacity
  // status. NULL = no threshold configured (auto status uses queue wait and
  // resource occupancy only).
  capacityThreshold: integer("capacity_threshold"),
  // Manual live-status override: available | moderate | busy. Empty string =
  // no override (status is derived automatically from live signals).
  capacityStatusOverride: text("capacity_status_override").notNull().default(""),
  // Optional expiry for the manual override; past this instant the status
  // reverts to automatic derivation. NULL = override holds until cleared.
  capacityOverrideExpiresAt: timestamp("capacity_override_expires_at"),
  // ── Tip pooling / gratuity splitting ──────────────────────────────────────
  // Default tip-split rule applied at checkout when a tip is captured:
  //   equal         — split evenly across the tenant's active staff pool
  //   percentage    — split by each staff member's tipPercent share
  //   role_weighted — split by each staff member's tipRoleWeight
  // A per-visit override can be passed at checkout.
  tipSplitRule: text("tip_split_rule").notNull().default("equal"),
  // Business-specific service names the AI receptionist should recognize,
  // in addition to the generic industry-neutral terms.
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sosResourcesTable = pgTable(
  "sos_resources",
  {
    id: serial("id").primaryKey(),
    // Tenant scope. NULL identifies legacy single-tenant rows.
    tenantId: integer("tenant_id").references(() => tenantsTable.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    resourceType: text("resource_type").notNull(),
    // available | occupied | cleaning | offline
    status: text("status").notNull().default("available"),
    currentVisitId: integer("current_visit_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("sos_resources_tenant_id_idx").on(t.tenantId)],
);

export const sosCustomersTable = pgTable(
  "sos_customers",
  {
  id: serial("id").primaryKey(),
  // Tenant scope. NULL identifies legacy single-tenant rows.
  tenantId: integer("tenant_id").references(() => tenantsTable.id, {
    onDelete: "cascade",
  }),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  smsOptIn: boolean("sms_opt_in").notNull().default(true),
  // Transactional email opt-in (confirmations, receipts). Independent of the
  // SMS flag — a customer can be reachable on either channel.
  emailOptIn: boolean("email_opt_in").notNull().default(true),
  // Explicit link to a concierge client_profiles row (marketing record for the
  // same person). Established by phone matching but survives phone edits.
  clientProfileId: integer("client_profile_id").references(
    () => clientProfilesTable.id,
    { onDelete: "set null" },
  ),
  visitCount: integer("visit_count").notNull().default(0),
  lastVisitAt: timestamp("last_visit_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("sos_customers_tenant_id_idx").on(t.tenantId)],
);

// ── staff members & compensation ─────────────────────────────────────────────

// Tenant-scoped staff (people, not chairs — physical stations stay in
// sos_resources). Each staff member has exactly one compensation model:
//  - commission:  commissionPercent is the staff member's share of the
//                 service revenue they're attributed on (single rate).
//  - flat_fee:    amount is owed to the staff member per cadence.
//  - booth_rent:  amount is owed BY the staff member per cadence.
export const sosStaffMembersTable = pgTable(
  "sos_staff_members",
  {
    id: serial("id").primaryKey(),
    // Tenant scope. NULL identifies legacy single-tenant rows.
    tenantId: integer("tenant_id").references(() => tenantsTable.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    // Deactivated staff are hidden from attribution pickers but keep their
    // historical visit attributions.
    isActive: boolean("is_active").notNull().default(true),
    // commission | flat_fee | booth_rent
    compensationType: text("compensation_type").notNull(),
    // commission only: whole-number percentage of attributed service revenue.
    commissionPercent: integer("commission_percent"),
    // flat_fee / booth_rent only: money amount per cadence.
    amount: numeric("amount", { precision: 10, scale: 2 }),
    // flat_fee / booth_rent only: weekly | monthly
    cadence: text("cadence"),
    // ── Tip pooling shares ────────────────────────────────────────────────────
    // percentage rule: this member's share of pooled tips (whole-number %).
    // Members with NULL/0 receive nothing under the percentage rule; shares
    // are normalized by the pool's total so they needn't sum to 100.
    tipPercent: integer("tip_percent"),
    // role_weighted rule: relative weight (e.g. senior=2, junior=1).
    // NULL = default weight 1.
    tipRoleWeight: integer("tip_role_weight"),
    // ── Credential registry (co-op shift coverage) ────────────────────────
    // Skills/specialties and certifications shown on the coverage card.
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    certifications: jsonb("certifications").$type<string[]>().notNull().default([]),
    // Professional license details. Verification is a manual attestation:
    // a named verifier flips the status; editing any license field resets it
    // to unverified. "Expired" is derived from licenseExpiresAt at read time,
    // never stored.
    licenseNumber: text("license_number"),
    licenseState: text("license_state"),
    licenseExpiresAt: timestamp("license_expires_at"),
    // unverified | verified (expired is computed from licenseExpiresAt)
    licenseVerificationStatus: text("license_verification_status")
      .notNull()
      .default("unverified"),
    licenseVerifiedBy: text("license_verified_by"),
    licenseVerifiedAt: timestamp("license_verified_at"),
    // Merchant opt-in: staff visible to accepted co-op partners as coverage
    // candidates (privacy-safe card — never compensation data).
    coopCoverageEnabled: boolean("coop_coverage_enabled").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("sos_staff_members_tenant_id_idx").on(t.tenantId)],
);

// ── co-op visit bundles ──────────────────────────────────────────────────────
// Links visits at two partnered businesses into one "shared appointment"
// bundle (e.g. a barbershop cut + partner-studio color booked as one outing).
// The bundle carries the partnership so tip pooling can resolve the
// partnership's split rule at checkout. Visits opt in via sos_visits.bundle_id.
export const sosVisitBundlesTable = pgTable(
  "sos_visit_bundles",
  {
    id: serial("id").primaryKey(),
    partnershipId: integer("partnership_id")
      .notNull()
      .references(() => merchantCoopPartnershipsTable.id, { onDelete: "cascade" }),
    // Tenant that opened the bundle (NULL identifies legacy scope).
    createdByTenantId: integer("created_by_tenant_id").references(() => tenantsTable.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("sos_visit_bundles_partnership_idx").on(t.partnershipId)],
);

export const sosVisitsTable = pgTable(
  "sos_visits",
  {
  id: serial("id").primaryKey(),
  // Tenant scope. NULL identifies legacy single-tenant rows.
  tenantId: integer("tenant_id").references(() => tenantsTable.id, {
    onDelete: "cascade",
  }),
  customerId: integer("customer_id")
    .notNull()
    .references(() => sosCustomersTable.id),
  // checked_in | queued | assigned | notified | in_service | payment | checked_out
  status: text("status").notNull().default("checked_in"),
  serviceType: text("service_type").notNull(),
  partySize: integer("party_size").notNull().default(1),
  resourceId: integer("resource_id").references(() => sosResourcesTable.id),
  // Optional staff attribution, captured at payment/checkout time. Kept even
  // if the staff member is later deactivated.
  staffId: integer("staff_id").references(() => sosStaffMembersTable.id),
  estimatedWaitMinutes: integer("estimated_wait_minutes"),
  paymentAmount: numeric("payment_amount", { precision: 10, scale: 2 }),
  // Gratuity captured at checkout, recorded SEPARATELY from service revenue.
  // Tips must never be folded into paymentAmount, revenue, commission bases,
  // or margin figures — they are pooled and split via the gratuity ledgers.
  tipAmount: numeric("tip_amount", { precision: 10, scale: 2 }),
  // Co-op shared-appointment bundle membership (NULL = standalone visit).
  bundleId: integer("bundle_id").references(() => sosVisitBundlesTable.id, {
    onDelete: "set null",
  }),
  checkedInAt: timestamp("checked_in_at").notNull().defaultNow(),
  serviceStartedAt: timestamp("service_started_at"),
  checkedOutAt: timestamp("checked_out_at"),
  },
  (t) => [index("sos_visits_tenant_id_idx").on(t.tenantId)],
);

export const sosAppointmentsTable = pgTable(
  "sos_appointments",
  {
  id: serial("id").primaryKey(),
  // Tenant scope. NULL identifies legacy single-tenant rows.
  tenantId: integer("tenant_id").references(() => tenantsTable.id, {
    onDelete: "cascade",
  }),
  customerId: integer("customer_id")
    .notNull()
    .references(() => sosCustomersTable.id),
  serviceType: text("service_type").notNull(),
  startsAt: timestamp("starts_at").notNull(),
  endsAt: timestamp("ends_at").notNull(),
  // booked | cancelled | completed | filled
  status: text("status").notNull().default("booked"),
  // staff | ai_receptionist | waitlist_fill | self_book
  source: text("source").notNull().default("staff"),
  resourceId: integer("resource_id").references(() => sosResourcesTable.id),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("sos_appointments_tenant_id_idx").on(t.tenantId)],
);

export const sosWaitlistTable = pgTable(
  "sos_waitlist_entries",
  {
  id: serial("id").primaryKey(),
  // Tenant scope. NULL identifies legacy single-tenant rows.
  tenantId: integer("tenant_id").references(() => tenantsTable.id, {
    onDelete: "cascade",
  }),
  customerId: integer("customer_id")
    .notNull()
    .references(() => sosCustomersTable.id),
  desiredService: text("desired_service").notNull(),
  // waiting | notified | booked | expired
  status: text("status").notNull().default("waiting"),
  notifiedAt: timestamp("notified_at"),
  openSlotStartsAt: timestamp("open_slot_starts_at"),
  openSlotEndsAt: timestamp("open_slot_ends_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("sos_waitlist_entries_tenant_id_idx").on(t.tenantId)],
);

// Card-on-file deposit holds (No-Show Shield module), backed by real Stripe
// authorizations. One hold per appointment; policy terms are snapshotted at
// booking time so later enforcement uses the terms in force when the slot
// was reserved.
export const sosDepositHoldsTable = pgTable("sos_deposit_holds", {
  id: serial("id").primaryKey(),
  appointmentId: integer("appointment_id")
    .notNull()
    .unique()
    .references(() => sosAppointmentsTable.id, { onDelete: "cascade" }),
  depositAmount: numeric("deposit_amount", { precision: 10, scale: 2 }).notNull(),
  feeAmount: numeric("fee_amount", { precision: 10, scale: 2 }).notNull(),
  cancellationWindowHours: integer("cancellation_window_hours").notNull(),
  // pending_authorization | held | released | captured | failed
  //  - pending_authorization: Stripe Checkout link created, waiting for the
  //    customer to enter their card (no money held yet)
  //  - held: card authorized on Stripe (manual-capture PaymentIntent)
  //  - released: authorization voided (timely cancellation)
  //  - captured: fee captured from the authorization (late cancel / no-show)
  //  - failed: authorization never happened or a Stripe operation failed —
  //    surfaced to staff via outcomeReason instead of pretending money is held
  status: text("status").notNull().default("pending_authorization"),
  // Stripe manual-capture PaymentIntent backing this hold (set once the
  // customer completes the Checkout session). NULL for legacy paper holds.
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  // Stripe Checkout session used to collect the card authorization.
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  // Hosted payment page the customer must complete to authorize the deposit.
  checkoutUrl: text("checkout_url"),
  // Human-readable reason for the outcome (why a fee was / wasn't charged).
  outcomeReason: text("outcome_reason"),
  // ── Failed-operation retry bookkeeping ─────────────────────────────────────
  // When a Stripe capture/void fails transiently, the hold stays "held" and
  // the failed operation is recorded here so the worker sweep can re-attempt
  // it. Cleared on success; NULL means no retry is pending.
  //   retryOperation: capture_late_cancel | capture_no_show | void
  retryOperation: text("retry_operation"),
  retryAttempts: integer("retry_attempts").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

// ── gratuity ledger ──────────────────────────────────────────────────────────
// One row per staff allocation of a pooled tip, written atomically with the
// checkout that captured the tip. tenantId is the STAFF MEMBER'S tenant (not
// necessarily the visit's tenant): on shared co-op visits the partner
// business's staff allocations land on the partner tenant's ledger. The
// ledger is append-only in practice — it is the auditable record for tax
// reporting, and tips here are never counted as service revenue.
export const sosGratuityLedgerTable = pgTable(
  "sos_gratuity_ledger",
  {
    id: serial("id").primaryKey(),
    // Tenant scope of the ALLOCATION (the staff member's tenant). NULL
    // identifies legacy single-tenant rows.
    tenantId: integer("tenant_id").references(() => tenantsTable.id, {
      onDelete: "cascade",
    }),
    visitId: integer("visit_id")
      .notNull()
      .references(() => sosVisitsTable.id, { onDelete: "cascade" }),
    staffId: integer("staff_id")
      .notNull()
      .references(() => sosStaffMembersTable.id, { onDelete: "cascade" }),
    // Split rule that produced this allocation: equal | percentage | role_weighted
    ruleApplied: text("rule_applied").notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("sos_gratuity_ledger_tenant_id_idx").on(t.tenantId),
    index("sos_gratuity_ledger_staff_created_idx").on(t.staffId, t.createdAt.desc()),
    index("sos_gratuity_ledger_visit_id_idx").on(t.visitId),
  ],
);

export type SosGratuityLedgerEntry = typeof sosGratuityLedgerTable.$inferSelect;

// ── memberships, packages & credit passes ───────────────────────────────────

// Plan catalog definitions a shop sells to its customers.
export const sosPlansTable = pgTable(
  "sos_plans",
  {
  id: serial("id").primaryKey(),
  // Tenant scope. NULL identifies legacy single-tenant rows.
  tenantId: integer("tenant_id").references(() => tenantsTable.id, {
    onDelete: "cascade",
  }),
  name: text("name").notNull(),
  // membership (recurring discount) | package (one-time bundle of credits) |
  // pass (credit-based loyalty pass)
  planType: text("plan_type").notNull(),
  description: text("description"),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  // Recurring memberships only: monthly | yearly
  billingInterval: text("billing_interval"),
  // Recurring memberships only: percentage discount applied at checkout.
  discountPercent: integer("discount_percent"),
  // Packages/passes only: number of prepaid service credits granted per purchase.
  creditCount: integer("credit_count"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("sos_plans_tenant_id_idx").on(t.tenantId)],
);

// A customer's enrollment in a plan (purchased at POS).
export const sosCustomerPlansTable = pgTable("sos_customer_plans", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id")
    .notNull()
    .references(() => sosCustomersTable.id),
  planId: integer("plan_id")
    .notNull()
    .references(() => sosPlansTable.id),
  // active | past_due | cancelled
  status: text("status").notNull().default("active"),
  // Packages/passes: credits remaining. NULL for memberships.
  remainingCredits: integer("remaining_credits"),
  // Memberships: next renewal/billing date. NULL for packages/passes.
  renewsAt: timestamp("renews_at"),
  purchasedAt: timestamp("purchased_at").notNull().defaultNow(),
  cancelledAt: timestamp("cancelled_at"),
});

// Ledger of purchases, renewals, redemptions, and discount applications.
export const sosPlanTransactionsTable = pgTable("sos_plan_transactions", {
  id: serial("id").primaryKey(),
  customerPlanId: integer("customer_plan_id")
    .notNull()
    .references(() => sosCustomerPlansTable.id),
  customerId: integer("customer_id")
    .notNull()
    .references(() => sosCustomersTable.id),
  visitId: integer("visit_id").references(() => sosVisitsTable.id),
  // purchase | renewal | redemption | discount | cancellation
  transactionType: text("transaction_type").notNull(),
  // Money collected (purchase/renewal) or discounted (discount). NULL when n/a.
  amount: numeric("amount", { precision: 10, scale: 2 }),
  // Credit movement: +N on purchase of packages/passes, -1 on redemption.
  creditsDelta: integer("credits_delta"),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── structured service catalog ──────────────────────────────────────────────
// Per-business service menu: categories, descriptions, flat-rate prices, and
// estimated durations. Replaces the legacy comma-separated
// sos_settings.service_names string (kept as a read-only fallback until each
// scope is backfilled into structured rows).
export const sosServicesTable = pgTable(
  "sos_services",
  {
    id: serial("id").primaryKey(),
    // Tenant scope. NULL identifies legacy single-tenant rows.
    tenantId: integer("tenant_id").references(() => tenantsTable.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    // Free-form grouping label (e.g. "Hair", "Nails"). NULL = uncategorized.
    category: text("category"),
    description: text("description"),
    // Flat-rate price. NULL when the business hasn't priced it yet (e.g.
    // rows backfilled from the legacy name-only setting).
    price: numeric("price", { precision: 10, scale: 2 }),
    // Estimated duration in minutes. NULL when unknown.
    durationMinutes: integer("duration_minutes"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("sos_services_tenant_id_idx").on(t.tenantId)],
);

// Customer reviews shown on the public SEO landing page. Owner-managed:
// businesses control which reviews are publicly visible via isVisible.
export const sosReviewsTable = pgTable(
  "sos_reviews",
  {
    id: serial("id").primaryKey(),
    // Tenant scope. NULL identifies legacy single-tenant rows.
    tenantId: integer("tenant_id").references(() => tenantsTable.id, {
      onDelete: "cascade",
    }),
    authorName: text("author_name").notNull(),
    // 1–5 stars (validated at the API layer).
    rating: integer("rating").notNull(),
    body: text("body").notNull().default(""),
    isVisible: boolean("is_visible").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("sos_reviews_tenant_id_idx").on(t.tenantId)],
);

// ── co-op tip pooling ────────────────────────────────────────────────────────

// Merchant-defined tip-splitting rules. Two scopes:
//  - partnership: shared/co-op appointments — the rule belongs to an accepted
//    + active co-op partnership; both partners can view it.
//  - group_event: the tenant's own multi-staff group events (single business).
// Split methods: percentage (per-participant percent summing to 100), equal,
// role_weighted (per-participant positive weights).
export const sosTipPoolRulesTable = pgTable(
  "sos_tip_pool_rules",
  {
    id: serial("id").primaryKey(),
    // Tenant that created (and may edit) the rule. NULL identifies legacy
    // single-tenant rows.
    tenantId: integer("tenant_id").references(() => tenantsTable.id, {
      onDelete: "cascade",
    }),
    // partnership | group_event
    scope: text("scope").notNull(),
    // partnership scope only.
    partnershipId: integer("partnership_id").references(
      () => merchantCoopPartnershipsTable.id,
      { onDelete: "cascade" },
    ),
    // percentage | equal | role_weighted
    splitMethod: text("split_method").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("sos_tip_pool_rules_tenant_idx").on(t.tenantId),
    index("sos_tip_pool_rules_partnership_idx").on(t.partnershipId),
  ],
);

// Recipients of a tip-pool rule: (business, staff member) pairs with the
// method-specific terms (percent for percentage rules, weight for
// role-weighted rules; equal rules carry neither).
export const sosTipPoolRuleParticipantsTable = pgTable(
  "sos_tip_pool_rule_participants",
  {
    id: serial("id").primaryKey(),
    ruleId: integer("rule_id")
      .notNull()
      .references(() => sosTipPoolRulesTable.id, { onDelete: "cascade" }),
    // Business the recipient staff member works for (NULL = legacy scope).
    tenantId: integer("tenant_id").references(() => tenantsTable.id, {
      onDelete: "cascade",
    }),
    staffId: integer("staff_id")
      .notNull()
      .references(() => sosStaffMembersTable.id, { onDelete: "cascade" }),
    // Optional human-readable role label (e.g. "Lead Stylist").
    role: text("role"),
    // percentage method: whole-number percent of the pooled tip.
    percent: integer("percent"),
    // role_weighted method: positive integer weight.
    weight: integer("weight"),
  },
  (t) => [index("sos_tip_pool_rule_participants_rule_idx").on(t.ruleId)],
);

// Immutable, itemized tip-pool ledger — one row per recipient staff member
// per pooled tip, written atomically with the checkout that captured the tip.
// Never re-split retroactively; the rule terms in force are snapshotted.
// (Distinct from sosGratuityLedgerTable, the per-tenant gratuity pool ledger:
// this one records rule-based / cross-business partnership splits.)
export const sosTipPoolLedgerTable = pgTable(
  "sos_gratuity_ledger_entries",
  {
    id: serial("id").primaryKey(),
    visitId: integer("visit_id")
      .notNull()
      .references(() => sosVisitsTable.id, { onDelete: "cascade" }),
    // Business where the tip was collected (NULL = legacy scope).
    sourceTenantId: integer("source_tenant_id").references(() => tenantsTable.id, {
      onDelete: "cascade",
    }),
    // Business the recipient staff member works for (NULL = legacy scope).
    recipientTenantId: integer("recipient_tenant_id").references(() => tenantsTable.id, {
      onDelete: "cascade",
    }),
    recipientStaffId: integer("recipient_staff_id")
      .notNull()
      .references(() => sosStaffMembersTable.id, { onDelete: "cascade" }),
    // Full tip captured at checkout (same on every row of the split).
    grossTip: numeric("gross_tip", { precision: 10, scale: 2 }).notNull(),
    // This recipient's share (deterministic rounding; remainder cents go to
    // the servicing staff member).
    allocatedShare: numeric("allocated_share", { precision: 10, scale: 2 }).notNull(),
    // Rule that produced the split; NULL = default (whole tip to the
    // servicing staff member, no rule configured).
    ruleId: integer("rule_id").references(() => sosTipPoolRulesTable.id, {
      onDelete: "set null",
    }),
    // Snapshot of the rule terms in force at checkout (method + participants)
    // so history stays interpretable after rule edits.
    ruleSnapshot: jsonb("rule_snapshot"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("sos_gratuity_ledger_visit_idx").on(t.visitId),
    // One ledger row per recipient per visit — a DB-level idempotency guard
    // so a replayed/concurrent checkout can never double-record a split.
    uniqueIndex("sos_gratuity_ledger_visit_recipient_uniq").on(t.visitId, t.recipientStaffId),
    index("sos_gratuity_ledger_recipient_tenant_created_idx").on(
      t.recipientTenantId,
      t.createdAt.desc(),
    ),
    index("sos_gratuity_ledger_recipient_staff_idx").on(t.recipientStaffId),
  ],
);

export type SosTipPoolRule = typeof sosTipPoolRulesTable.$inferSelect;
export type SosTipPoolRuleParticipant = typeof sosTipPoolRuleParticipantsTable.$inferSelect;
export type SosVisitBundle = typeof sosVisitBundlesTable.$inferSelect;
export type SosTipPoolLedgerEntry = typeof sosTipPoolLedgerTable.$inferSelect;

export const sosCallsTable = pgTable(
  "sos_calls",
  {
  id: serial("id").primaryKey(),
  // Tenant scope. NULL identifies legacy single-tenant rows.
  tenantId: integer("tenant_id").references(() => tenantsTable.id, {
    onDelete: "cascade",
  }),
  fromNumber: text("from_number").notNull(),
  callerName: text("caller_name"),
  intent: text("intent").notNull(),
  transcriptSummary: text("transcript_summary"),
  // booked | followup_sms | message_taken | no_action
  outcome: text("outcome").notNull().default("no_action"),
  appointmentId: integer("appointment_id").references(() => sosAppointmentsTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("sos_calls_tenant_id_idx").on(t.tenantId)],
);

// ── Co-op shift coverage marketplace ─────────────────────────────────────────
// A merchant short on staff posts an open shift; accepted, active co-op
// partners see it and can offer one of their eligible (verified, unexpired,
// state-matching, skill-matching) staff. The poster accepts exactly one offer
// (conditional-update concurrency guard), then completes/cancels the shift,
// recording actual hours. Rates are tracked, never settled — no payments.

export const coopCoverageShiftsTable = pgTable(
  "coop_coverage_shifts",
  {
    id: serial("id").primaryKey(),
    // The posting (host) business. Coverage is tenant-only — no legacy scope.
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at").notNull(),
    endsAt: timestamp("ends_at").notNull(),
    // Skill the covering staff member must list (case-insensitive match).
    requiredSkill: text("required_skill").notNull(),
    // License state the covering staff member must be licensed in — defaults
    // to the posting business's own state at post time.
    requiredLicenseState: text("required_license_state").notNull(),
    offeredHourlyRate: numeric("offered_hourly_rate", { precision: 10, scale: 2 }).notNull(),
    notes: text("notes"),
    // open | offered | confirmed | completed | cancelled
    status: text("status").notNull().default("open"),
    // Winning offer once the poster accepts. The conditional UPDATE that sets
    // this (guarded on status + accepted_offer_id IS NULL) is the single-
    // winner lock under concurrent accepts.
    acceptedOfferId: integer("accepted_offer_id"),
    // Actual hours recorded at completion.
    hoursWorked: numeric("hours_worked", { precision: 6, scale: 2 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("coop_coverage_shifts_tenant_idx").on(t.tenantId)],
);

export type CoopCoverageShift = typeof coopCoverageShiftsTable.$inferSelect;

export const coopCoverageOffersTable = pgTable(
  "coop_coverage_offers",
  {
    id: serial("id").primaryKey(),
    shiftId: integer("shift_id")
      .notNull()
      .references(() => coopCoverageShiftsTable.id, { onDelete: "cascade" }),
    // The partner business offering one of its staff.
    offeringTenantId: integer("offering_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    staffId: integer("staff_id")
      .notNull()
      .references(() => sosStaffMembersTable.id, { onDelete: "cascade" }),
    note: text("note"),
    // pending | accepted | declined
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // One offer per staff member per shift.
    unique("coop_coverage_offers_shift_staff_uq").on(t.shiftId, t.staffId),
    index("coop_coverage_offers_shift_idx").on(t.shiftId),
    index("coop_coverage_offers_tenant_idx").on(t.offeringTenantId),
  ],
);

export type CoopCoverageOffer = typeof coopCoverageOffersTable.$inferSelect;

// Cross-store rating the host leaves for the covering staff member after a
// completed shift. One rating per shift; the average shows on the staff
// member's coverage card.
export const coopCoverageRatingsTable = pgTable(
  "coop_coverage_ratings",
  {
    id: serial("id").primaryKey(),
    shiftId: integer("shift_id")
      .notNull()
      .unique()
      .references(() => coopCoverageShiftsTable.id, { onDelete: "cascade" }),
    staffId: integer("staff_id")
      .notNull()
      .references(() => sosStaffMembersTable.id, { onDelete: "cascade" }),
    ratedByTenantId: integer("rated_by_tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    // 1–5 (validated at the API layer).
    rating: integer("rating").notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("coop_coverage_ratings_staff_idx").on(t.staffId)],
);

export type CoopCoverageRating = typeof coopCoverageRatingsTable.$inferSelect;
