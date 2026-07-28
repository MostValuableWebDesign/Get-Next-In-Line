import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./agency";

// ── Co-Op Tax & Revenue Compliance Ledger ────────────────────────────────────
// Tenant-scoped tax tracking of co-op financial activity: perk redemptions
// with a monetary value, referral commissions, sponsorships/placements, and
// shared event expenses. Estimated-tax figures are merchant-configured
// ESTIMATES only ("consult your accountant") — no filing, no money movement.

// Per-tenant tax settings. NULL tenant identifies the legacy single-tenant
// scope (same convention as sos_settings). Rows are auto-created on first
// access; rate changes only affect NEW ledger entries — historical entries
// keep the rate snapshot in force when they were logged.
export const coopTaxSettingsTable = pgTable("coop_tax_settings", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .unique()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  // Merchant-configured estimated tax rates (percent).
  stateRatePercent: numeric("state_rate_percent", { precision: 5, scale: 2 }).notNull().default("0"),
  localRatePercent: numeric("local_rate_percent", { precision: 5, scale: 2 }).notNull().default("0"),
  salesRatePercent: numeric("sales_rate_percent", { precision: 5, scale: 2 }).notNull().default("0"),
  // Calendar-year payout total at/above which a payee is flagged for a 1099.
  threshold1099: numeric("threshold_1099", { precision: 10, scale: 2 }).notNull().default("600"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CoopTaxSettings = typeof coopTaxSettingsTable.$inferSelect;

// One row per co-op financial event, written automatically (perk redemptions
// with monetary terms) or via manual entry (sponsorships, shared expenses,
// referral commissions). The unique source_ref makes automatic capture
// idempotent under retries/replays. Rate columns are a SNAPSHOT of the
// tenant's settings when the entry was logged — never recomputed.
export const coopComplianceLedgerTable = pgTable(
  "coop_compliance_ledger",
  {
    id: serial("id").primaryKey(),
    // Tenant the entry belongs to. NULL = legacy single-tenant scope.
    tenantId: integer("tenant_id").references(() => tenantsTable.id, { onDelete: "cascade" }),
    // perk_redemption | referral_commission | sponsorship | shared_expense
    category: text("category").notNull(),
    // income | expense — which side of the tenant's books the event lands on.
    direction: text("direction").notNull(),
    // The other business in the transaction, when on-platform.
    counterpartTenantId: integer("counterpart_tenant_id").references(() => tenantsTable.id, {
      onDelete: "set null",
    }),
    // Off-platform payee/partner name (referral agents, co-op contributors).
    payeeName: text("payee_name"),
    description: text("description"),
    grossAmount: numeric("gross_amount", { precision: 12, scale: 2 }).notNull(),
    // Tax-rate snapshot (percent) in force when the entry was logged.
    stateRatePercent: numeric("state_rate_percent", { precision: 5, scale: 2 }).notNull(),
    localRatePercent: numeric("local_rate_percent", { precision: 5, scale: 2 }).notNull(),
    salesRatePercent: numeric("sales_rate_percent", { precision: 5, scale: 2 }).notNull(),
    // gross × (state + local + sales) / 100, computed at write time.
    estimatedTaxAmount: numeric("estimated_tax_amount", { precision: 12, scale: 2 }).notNull(),
    // Stable reference to the originating row for automatic capture, e.g.
    // "coop_perk_redemptions:12"; manual entries get "manual:<uuid>".
    sourceRef: text("source_ref").notNull().unique(),
    // When the underlying financial event happened (period bucketing key).
    occurredAt: timestamp("occurred_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("coop_compliance_ledger_tenant_occurred_idx").on(t.tenantId, t.occurredAt.desc()),
  ],
);

export type CoopComplianceLedgerEntry = typeof coopComplianceLedgerTable.$inferSelect;

// Cumulative calendar-year payout accumulation per payee, maintained in
// lockstep with expense-side ledger writes that name a payee. Keyed by a
// normalized payee key so "Jane Doe" and "jane doe" accumulate together;
// on-platform counterparts use "tenant:<id>".
export const coopPartnerPayoutsTable = pgTable(
  "coop_partner_payouts",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").references(() => tenantsTable.id, { onDelete: "cascade" }),
    payeeKey: text("payee_key").notNull(),
    payeeName: text("payee_name").notNull(),
    calendarYear: integer("calendar_year").notNull(),
    totalPaid: numeric("total_paid", { precision: 12, scale: 2 }).notNull().default("0"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("coop_partner_payouts_scope_uq").on(t.tenantId, t.payeeKey, t.calendarYear),
    index("coop_partner_payouts_tenant_year_idx").on(t.tenantId, t.calendarYear),
  ],
);

export type CoopPartnerPayout = typeof coopPartnerPayoutsTable.$inferSelect;
