import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  timestamp,
  unique,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { tenantsTable, merchantCoopPartnershipsTable } from "./agency";

// ---------------------------------------------------------------------------
// Co-Op Settlement Clearinghouse
//
// Records the inter-business obligations the co-op network generates
// (referral fees, cooperative ad-pool contributions, perk-driven balances)
// and nets them into per-tenant statements at end of cycle. All amounts are
// persisted at event time (realized-amount rule) — never recomputed from
// current partnership/markup settings. No real money moves here.
// ---------------------------------------------------------------------------

// One settlement run over a date window. Cycles are append-only from the
// API's perspective: once executed they can be viewed but never edited —
// there are no update routes, and statements/entries reference the cycle
// immutably.
export const coopSettlementCyclesTable = pgTable(
  "coop_settlement_cycles",
  {
    id: serial("id").primaryKey(),
    // Window of obligation `occurredAt` values included: [periodStart, periodEnd).
    periodStart: timestamp("period_start").notNull(),
    periodEnd: timestamp("period_end").notNull(),
    // closed — cycles are created already-closed by the settlement run.
    status: text("status").notNull().default("closed"),
    // Number of ledger entries settled by this cycle.
    entryCount: integer("entry_count").notNull().default(0),
    // Sum of all obligation amounts settled (gross, before pairwise netting).
    grossVolume: numeric("gross_volume", { precision: 12, scale: 2 }).notNull().default("0"),
    executedAt: timestamp("executed_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("coop_settlement_cycles_executed_idx").on(t.executedAt.desc())],
);

export type CoopSettlementCycle = typeof coopSettlementCyclesTable.$inferSelect;

// Inter-business obligation ledger: `debtor owes creditor amount` for a
// specific co-op event. The unique (kind, sourceRef) pair is the idempotency
// lock — hooks can be re-invoked (retries, POS + native paths) without ever
// double-recording an obligation. settlementCycleId NULL = unsettled; a
// settlement run claims entries by setting it, so an entry can never be
// counted in two cycles.
export const coopObligationLedgerTable = pgTable(
  "coop_obligation_ledger",
  {
    id: serial("id").primaryKey(),
    debtorTenantId: integer("debtor_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    creditorTenantId: integer("creditor_tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // referral_fee | ad_pool_contribution | perk_obligation | coverage_labor
    kind: text("kind").notNull(),
    // Positive dollars the debtor owes the creditor, captured from the
    // per-transaction amount persisted at event time.
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    // Stable reference to the originating row, e.g.
    // "coop_perk_redemptions:12" or "coop_community_event_expenses:3:45".
    sourceRef: text("source_ref").notNull(),
    partnershipId: integer("partnership_id").references(
      () => merchantCoopPartnershipsTable.id,
      { onDelete: "set null" },
    ),
    description: text("description"),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    // NULL = unsettled. Set exactly once by the settlement run that included
    // this entry.
    settlementCycleId: integer("settlement_cycle_id").references(
      () => coopSettlementCyclesTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("coop_obligation_ledger_kind_source_ref_uq").on(t.kind, t.sourceRef),
    // Settlement sweep: unsettled entries (NULL cycle) in a date window.
    index("coop_obligation_ledger_cycle_occurred_idx").on(t.settlementCycleId, t.occurredAt),
    index("coop_obligation_ledger_debtor_idx").on(t.debtorTenantId),
    index("coop_obligation_ledger_creditor_idx").on(t.creditorTenantId),
  ],
);

export type CoopObligationLedgerEntry = typeof coopObligationLedgerTable.$inferSelect;

// A pairwise line inside a tenant's settlement statement.
export interface SettlementStatementLine {
  counterpartyTenantId: number;
  counterpartyName: string;
  // Gross dollars this tenant owed the counterparty in the cycle window.
  owedToCounterparty: number;
  // Gross dollars the counterparty owed this tenant.
  owedByCounterparty: number;
  // Net for this pair from this tenant's perspective (positive = receives).
  net: number;
}

// Per-tenant statement for one cycle: the pairwise-netted result of every
// obligation involving the tenant in the cycle window.
export const coopSettlementStatementsTable = pgTable(
  "coop_settlement_statements",
  {
    id: serial("id").primaryKey(),
    cycleId: integer("cycle_id")
      .notNull()
      .references(() => coopSettlementCyclesTable.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    // Gross totals before netting (sum over all counterparties).
    totalOwedToOthers: numeric("total_owed_to_others", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    totalOwedByOthers: numeric("total_owed_by_others", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    // Net balance (positive = tenant receives from the network).
    netAmount: numeric("net_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    // Pairwise breakdown, snapshotted at settlement time (names included so
    // the statement stays readable even if a counterparty is later deleted).
    lines: jsonb("lines").$type<SettlementStatementLine[]>().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("coop_settlement_statements_cycle_tenant_uq").on(t.cycleId, t.tenantId),
    index("coop_settlement_statements_tenant_idx").on(t.tenantId),
  ],
);

export type CoopSettlementStatement = typeof coopSettlementStatementsTable.$inferSelect;
