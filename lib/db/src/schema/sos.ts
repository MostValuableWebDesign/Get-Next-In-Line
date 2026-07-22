import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { clientProfilesTable } from "./concierge";
import { tenantsTable } from "./agency";

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
  // Business-specific service names the AI receptionist should recognize,
  // in addition to the generic industry-neutral terms.
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sosResourcesTable = pgTable("sos_resources", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  resourceType: text("resource_type").notNull(),
  // available | occupied | cleaning | offline
  status: text("status").notNull().default("available"),
  currentVisitId: integer("current_visit_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sosCustomersTable = pgTable("sos_customers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  smsOptIn: boolean("sms_opt_in").notNull().default(true),
  // Explicit link to a concierge client_profiles row (marketing record for the
  // same person). Established by phone matching but survives phone edits.
  clientProfileId: integer("client_profile_id").references(
    () => clientProfilesTable.id,
    { onDelete: "set null" },
  ),
  visitCount: integer("visit_count").notNull().default(0),
  lastVisitAt: timestamp("last_visit_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sosVisitsTable = pgTable("sos_visits", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id")
    .notNull()
    .references(() => sosCustomersTable.id),
  // checked_in | queued | assigned | notified | in_service | payment | checked_out
  status: text("status").notNull().default("checked_in"),
  serviceType: text("service_type").notNull(),
  partySize: integer("party_size").notNull().default(1),
  resourceId: integer("resource_id").references(() => sosResourcesTable.id),
  estimatedWaitMinutes: integer("estimated_wait_minutes"),
  paymentAmount: numeric("payment_amount", { precision: 10, scale: 2 }),
  checkedInAt: timestamp("checked_in_at").notNull().defaultNow(),
  serviceStartedAt: timestamp("service_started_at"),
  checkedOutAt: timestamp("checked_out_at"),
});

export const sosAppointmentsTable = pgTable("sos_appointments", {
  id: serial("id").primaryKey(),
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
});

export const sosWaitlistTable = pgTable("sos_waitlist_entries", {
  id: serial("id").primaryKey(),
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
});

// Internal simulated card-on-file deposit holds (No-Show Shield module).
// One hold per appointment; policy terms are snapshotted at booking time so
// later enforcement uses the terms in force when the slot was reserved.
export const sosDepositHoldsTable = pgTable("sos_deposit_holds", {
  id: serial("id").primaryKey(),
  appointmentId: integer("appointment_id")
    .notNull()
    .unique()
    .references(() => sosAppointmentsTable.id, { onDelete: "cascade" }),
  depositAmount: numeric("deposit_amount", { precision: 10, scale: 2 }).notNull(),
  feeAmount: numeric("fee_amount", { precision: 10, scale: 2 }).notNull(),
  cancellationWindowHours: integer("cancellation_window_hours").notNull(),
  // held | released | captured
  status: text("status").notNull().default("held"),
  // Human-readable reason for the outcome (why a fee was / wasn't charged).
  outcomeReason: text("outcome_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

// ── memberships, packages & credit passes ───────────────────────────────────

// Plan catalog definitions a shop sells to its customers.
export const sosPlansTable = pgTable("sos_plans", {
  id: serial("id").primaryKey(),
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
});

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

export const sosCallsTable = pgTable("sos_calls", {
  id: serial("id").primaryKey(),
  fromNumber: text("from_number").notNull(),
  callerName: text("caller_name"),
  intent: text("intent").notNull(),
  transcriptSummary: text("transcript_summary"),
  // booked | followup_sms | message_taken | no_action
  outcome: text("outcome").notNull().default("no_action"),
  appointmentId: integer("appointment_id").references(() => sosAppointmentsTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
