import {
  db,
  tenantsTable,
  coopObligationLedgerTable,
  coopSettlementCyclesTable,
  coopSettlementStatementsTable,
  type CoopObligationLedgerEntry,
  type CoopSettlementCycle,
  type CoopSettlementStatement,
  type MerchantCoopPartnership,
  type SettlementStatementLine,
} from "@workspace/db";
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Co-Op Settlement Clearinghouse engine.
//
// Obligation hooks write `debtor owes creditor amount` rows into the
// inter-business obligation ledger as co-op events happen (idempotent per
// (kind, sourceRef)). The end-of-cycle run nets each pair's obligations,
// produces a per-tenant statement, and stamps the included entries with the
// cycle id — all inside one advisory-locked transaction so concurrent runs
// can never double-settle.
// ---------------------------------------------------------------------------

export const OBLIGATION_KINDS = ["referral_fee", "ad_pool_contribution", "perk_obligation"] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

// Distinct from CONCIERGE_LOCK_KEY (0x676e696c) — settlement runs must not
// contend with the concierge tick, only with other settlement runs.
export const SETTLEMENT_LOCK_KEY = 0x73_65_74_6c; // "setl"

const money = (cents: number) => (cents / 100).toFixed(2);
const toCents = (amount: string | number) =>
  Math.round((typeof amount === "string" ? parseFloat(amount) : amount) * 100);

export interface ObligationEvent {
  debtorTenantId: number;
  creditorTenantId: number;
  kind: ObligationKind;
  /** Positive dollars, already realized/persisted at event time. */
  amount: number;
  sourceRef: string;
  partnershipId?: number | null;
  description?: string;
  occurredAt?: Date;
}

/**
 * Append obligations to the inter-business ledger. Idempotent per
 * (kind, sourceRef) — safe to re-invoke from retried hooks. Never throws:
 * the originating co-op event is the source of truth and must not fail
 * because clearinghouse accounting hiccuped.
 */
export async function recordObligationsSafe(events: ObligationEvent[]): Promise<void> {
  const rows = events
    .filter((e) => e.amount > 0 && e.debtorTenantId !== e.creditorTenantId)
    .map((e) => ({
      debtorTenantId: e.debtorTenantId,
      creditorTenantId: e.creditorTenantId,
      kind: e.kind,
      amount: money(toCents(e.amount)),
      sourceRef: e.sourceRef,
      partnershipId: e.partnershipId ?? null,
      description: e.description ?? null,
      occurredAt: e.occurredAt ?? new Date(),
    }));
  if (rows.length === 0) return;
  try {
    await db.insert(coopObligationLedgerTable).values(rows).onConflictDoNothing();
  } catch (err) {
    logger.error(
      { err, sourceRefs: rows.map((r) => r.sourceRef) },
      "CO-OP OBLIGATION LEDGER WRITE FAILED — clearinghouse is missing entries",
    );
  }
}

/**
 * Obligation hook for a perk redemption. Called from the single revenue
 * accounting choke point every redemption path (native route, wallet,
 * gateway) already flows through.
 *
 *  - Revenue-share partnerships: the redeeming business owes the referring
 *    partner the GROSS share (referral_fee). Amounts come from the terms
 *    persisted on the partnership row at redemption time.
 *  - Classic mutual-perk pacts with a monetary perk value: the referring
 *    partner owes the redeeming business the perk's value (perk_obligation)
 *    — the redeemer honored a discount for the partner's customer.
 */
export async function recordRedemptionObligationsSafe(
  partnership: MerchantCoopPartnership,
  redemptionId: number,
  redeemingTenantId: number,
): Promise<void> {
  if (
    redeemingTenantId !== partnership.hostTenantId &&
    redeemingTenantId !== partnership.partnerTenantId
  ) {
    return;
  }
  const otherTenantId =
    redeemingTenantId === partnership.hostTenantId
      ? partnership.partnerTenantId
      : partnership.hostTenantId;
  if (otherTenantId === redeemingTenantId) return; // self-paired (HQ template) rows never settle

  const sourceRef = `coop_perk_redemptions:${redemptionId}`;
  if (partnership.revenueShareKind) {
    const value = parseFloat(partnership.revenueShareValue ?? "0");
    let gross = 0;
    if (partnership.revenueShareKind === "bounty") {
      gross = value;
    } else if (partnership.revenueShareKind === "percent") {
      gross = (parseFloat(partnership.revenueShareBaseAmount ?? "0") * value) / 100;
    }
    gross = Math.round(gross * 100) / 100;
    await recordObligationsSafe([
      {
        debtorTenantId: redeemingTenantId,
        creditorTenantId: otherTenantId,
        kind: "referral_fee",
        amount: gross,
        sourceRef,
        partnershipId: partnership.id,
        description: `Referral fee — "${partnership.perkTitle}"`,
      },
    ]);
    return;
  }
  const perkValue = partnership.perkValueAmount != null ? parseFloat(partnership.perkValueAmount) : 0;
  await recordObligationsSafe([
    {
      debtorTenantId: otherTenantId,
      creditorTenantId: redeemingTenantId,
      kind: "perk_obligation",
      amount: perkValue,
      sourceRef,
      partnershipId: partnership.id,
      description: `Perk honored — "${partnership.perkTitle}"`,
    },
  ]);
}

// ── Pairwise netting ─────────────────────────────────────────────────────────

export interface NettedStatement {
  tenantId: number;
  totalOwedToOthers: number;
  totalOwedByOthers: number;
  netAmount: number;
  lines: SettlementStatementLine[];
}

type LedgerLike = Pick<
  CoopObligationLedgerEntry,
  "debtorTenantId" | "creditorTenantId" | "amount"
>;

/**
 * Net a batch of obligations pairwise into per-tenant statements.
 * Pure integer-cents math; `net` per pair is antisymmetric by construction
 * so the sum of every statement's netAmount is exactly zero.
 */
export function netObligations(
  entries: LedgerLike[],
  tenantNames: Map<number, string>,
): NettedStatement[] {
  // owedCents[debtor][creditor] = gross cents debtor owes creditor.
  const owed = new Map<number, Map<number, number>>();
  const tenants = new Set<number>();
  for (const e of entries) {
    tenants.add(e.debtorTenantId).add(e.creditorTenantId);
    const byCreditor = owed.get(e.debtorTenantId) ?? new Map<number, number>();
    byCreditor.set(
      e.creditorTenantId,
      (byCreditor.get(e.creditorTenantId) ?? 0) + toCents(e.amount),
    );
    owed.set(e.debtorTenantId, byCreditor);
  }
  const owes = (a: number, b: number) => owed.get(a)?.get(b) ?? 0;

  const statements: NettedStatement[] = [];
  for (const tenantId of [...tenants].sort((a, b) => a - b)) {
    const counterparties = new Set<number>();
    for (const other of owed.get(tenantId)?.keys() ?? []) counterparties.add(other);
    for (const [debtor, byCreditor] of owed) {
      if (debtor !== tenantId && byCreditor.has(tenantId)) counterparties.add(debtor);
    }
    let owedToOthers = 0;
    let owedByOthers = 0;
    const lines: SettlementStatementLine[] = [];
    for (const other of [...counterparties].sort((a, b) => a - b)) {
      const iOwe = owes(tenantId, other);
      const theyOwe = owes(other, tenantId);
      owedToOthers += iOwe;
      owedByOthers += theyOwe;
      lines.push({
        counterpartyTenantId: other,
        counterpartyName: tenantNames.get(other) ?? `Business #${other}`,
        owedToCounterparty: iOwe / 100,
        owedByCounterparty: theyOwe / 100,
        net: (theyOwe - iOwe) / 100,
      });
    }
    statements.push({
      tenantId,
      totalOwedToOthers: owedToOthers / 100,
      totalOwedByOthers: owedByOthers / 100,
      netAmount: (owedByOthers - owedToOthers) / 100,
      lines,
    });
  }
  return statements;
}

// ── Preview & execution ──────────────────────────────────────────────────────

export interface SettlementPreviewResult {
  entries: CoopObligationLedgerEntry[];
  statements: NettedStatement[];
  grossVolume: number;
  tenantNames: Map<number, string>;
}

async function namesFor(tenantIds: number[]): Promise<Map<number, string>> {
  if (tenantIds.length === 0) return new Map();
  const rows = await db
    .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(inArray(tenantsTable.id, tenantIds));
  return new Map(rows.map((r) => [r.id, r.brandName]));
}

function unsettledInWindow(periodStart: Date, periodEnd: Date) {
  return and(
    isNull(coopObligationLedgerTable.settlementCycleId),
    gte(coopObligationLedgerTable.occurredAt, periodStart),
    lt(coopObligationLedgerTable.occurredAt, periodEnd),
  );
}

/** Unsettled entries in the window plus the netting they would produce. */
export async function previewSettlement(
  periodStart: Date,
  periodEnd: Date,
): Promise<SettlementPreviewResult> {
  const entries = await db
    .select()
    .from(coopObligationLedgerTable)
    .where(unsettledInWindow(periodStart, periodEnd))
    .orderBy(coopObligationLedgerTable.occurredAt, coopObligationLedgerTable.id);
  const tenantNames = await namesFor([
    ...new Set(entries.flatMap((e) => [e.debtorTenantId, e.creditorTenantId])),
  ]);
  const statements = netObligations(entries, tenantNames);
  const grossVolume =
    entries.reduce((sum, e) => sum + toCents(e.amount), 0) / 100;
  return { entries, statements, grossVolume, tenantNames };
}

export type SettlementRunResult =
  | { ok: true; cycle: CoopSettlementCycle; statements: CoopSettlementStatement[] }
  | { ok: false; reason: "concurrent" | "empty" };

/**
 * Execute an end-of-cycle settlement over [periodStart, periodEnd).
 *
 * Single transaction guarded by a tx-scoped advisory lock (same pattern as
 * the concierge tick — auto-released on commit/rollback/crash): gather the
 * unsettled entries, net pairwise, persist the cycle + per-tenant
 * statements, and stamp every included entry with the cycle id. The stamp
 * update is conditioned on `settlement_cycle_id IS NULL`, so even a lock
 * bypass could never double-settle an entry.
 */
export async function runSettlementCycle(
  periodStart: Date,
  periodEnd: Date,
): Promise<SettlementRunResult> {
  return db.transaction(async (tx) => {
    const lockRes = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${SETTLEMENT_LOCK_KEY}) as locked`,
    );
    const locked = Boolean((lockRes.rows?.[0] as { locked?: boolean } | undefined)?.locked);
    if (!locked) return { ok: false as const, reason: "concurrent" as const };

    const entries = await tx
      .select()
      .from(coopObligationLedgerTable)
      .where(unsettledInWindow(periodStart, periodEnd))
      .for("update")
      .orderBy(coopObligationLedgerTable.id);
    if (entries.length === 0) return { ok: false as const, reason: "empty" as const };

    const tenantIds = [...new Set(entries.flatMap((e) => [e.debtorTenantId, e.creditorTenantId]))];
    const nameRows = await tx
      .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, tenantIds));
    const tenantNames = new Map(nameRows.map((r) => [r.id, r.brandName]));

    const netted = netObligations(entries, tenantNames);
    const grossCents = entries.reduce((sum, e) => sum + toCents(e.amount), 0);

    const [cycle] = await tx
      .insert(coopSettlementCyclesTable)
      .values({
        periodStart,
        periodEnd,
        status: "closed",
        entryCount: entries.length,
        grossVolume: money(grossCents),
      })
      .returning();

    const statements = await tx
      .insert(coopSettlementStatementsTable)
      .values(
        netted.map((s) => ({
          cycleId: cycle.id,
          tenantId: s.tenantId,
          totalOwedToOthers: money(toCents(s.totalOwedToOthers)),
          totalOwedByOthers: money(toCents(s.totalOwedByOthers)),
          netAmount: money(toCents(s.netAmount)),
          lines: s.lines,
        })),
      )
      .returning();

    const stamped = await tx
      .update(coopObligationLedgerTable)
      .set({ settlementCycleId: cycle.id })
      .where(
        and(
          inArray(coopObligationLedgerTable.id, entries.map((e) => e.id)),
          isNull(coopObligationLedgerTable.settlementCycleId),
        ),
      )
      .returning({ id: coopObligationLedgerTable.id });
    if (stamped.length !== entries.length) {
      // Should be impossible under the lock + FOR UPDATE; refuse to settle
      // a partial batch rather than silently under-counting.
      throw new Error(
        `settlement stamp mismatch: locked ${entries.length} entries but stamped ${stamped.length}`,
      );
    }

    logger.info(
      { cycleId: cycle.id, entryCount: entries.length, statements: statements.length },
      "co-op settlement cycle executed",
    );
    return { ok: true as const, cycle, statements };
  });
}

/** Ledger entries settled by a given cycle (for statement drill-down). */
export async function entriesForCycleTenant(
  cycleId: number,
  tenantId: number,
): Promise<CoopObligationLedgerEntry[]> {
  return db
    .select()
    .from(coopObligationLedgerTable)
    .where(
      and(
        eq(coopObligationLedgerTable.settlementCycleId, cycleId),
        sql`(${coopObligationLedgerTable.debtorTenantId} = ${tenantId} or ${coopObligationLedgerTable.creditorTenantId} = ${tenantId})`,
      ),
    )
    .orderBy(coopObligationLedgerTable.occurredAt, coopObligationLedgerTable.id);
}
