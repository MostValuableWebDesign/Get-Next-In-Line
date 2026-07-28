import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  coopFinancialDisputesTable,
  coopFinancialDisputeEvidenceTable,
  coopFinancialDisputeEventsTable,
  coopLedgerAdjustmentsTable,
  coopPerkRedemptionsTable,
  coopTenantSuspensionsTable,
  sosSettingsTable,
  type CoopFinancialDispute,
  type CoopTenantSuspension,
} from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { and, count, eq, gte, inArray, lte, asc } from "drizzle-orm";
import { sendMessageSafe } from "./messaging";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Co-op financial dispute mediation: reconciliation engine, serialization,
// tenant co-op suspension helpers, and repeat-violator automation.
//
// Ledger adjustments and bounty reversals recorded here are compensating
// entries that inform settlement between the two businesses — never actual
// money movement.
// ---------------------------------------------------------------------------

// Tolerance (in redemption count) within which the platform's own ledger is
// considered to confirm one party's figure. Exact match by default;
// configurable without a redeploy of business logic elsewhere.
export function reconciliationCountTolerance(): number {
  const v = Number(process.env.COOP_RECONCILIATION_COUNT_TOLERANCE);
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

// Repeat-violator automation: rulings-against threshold within a rolling
// window (days). Both configurable via env so admins can tune without a
// code change.
export function repeatViolatorThreshold(): number {
  const v = Number(process.env.COOP_REPEAT_VIOLATOR_THRESHOLD);
  return Number.isInteger(v) && v > 0 ? v : 3;
}
export function repeatViolatorWindowDays(): number {
  const v = Number(process.env.COOP_REPEAT_VIOLATOR_WINDOW_DAYS);
  return Number.isInteger(v) && v > 0 ? v : 90;
}

export function financialDisputeRows() {
  const filerTenants = alias(tenantsTable, "fin_dispute_filer");
  const respondentTenants = alias(tenantsTable, "fin_dispute_respondent");
  return db
    .select({
      dispute: coopFinancialDisputesTable,
      perkTitle: merchantCoopPartnershipsTable.perkTitle,
      filedByTenantName: filerTenants.brandName,
      respondentTenantName: respondentTenants.brandName,
    })
    .from(coopFinancialDisputesTable)
    .innerJoin(
      merchantCoopPartnershipsTable,
      eq(coopFinancialDisputesTable.partnershipId, merchantCoopPartnershipsTable.id)
    )
    .innerJoin(filerTenants, eq(coopFinancialDisputesTable.filedByTenantId, filerTenants.id))
    .innerJoin(
      respondentTenants,
      eq(coopFinancialDisputesTable.respondentTenantId, respondentTenants.id)
    );
}

const numeric = (v: string | null): number | null => (v == null ? null : parseFloat(v));

/** Load and serialize the full ticket (evidence, events, adjustments) for one or many disputes. */
export async function serializeFinancialDisputes(
  rows: Awaited<ReturnType<ReturnType<typeof financialDisputeRows>["execute"]>>
) {
  const ids = rows.map((r) => r.dispute.id);
  if (ids.length === 0) return [];
  const creditTenants = alias(tenantsTable, "adj_credit_tenant");
  const debitTenants = alias(tenantsTable, "adj_debit_tenant");
  const [evidence, events, adjustments] = await Promise.all([
    db
      .select({
        row: coopFinancialDisputeEvidenceTable,
        redemptionPassCode: coopPerkRedemptionsTable.passCode,
        redemptionRedeemedAt: coopPerkRedemptionsTable.redeemedAt,
      })
      .from(coopFinancialDisputeEvidenceTable)
      .leftJoin(
        coopPerkRedemptionsTable,
        eq(coopFinancialDisputeEvidenceTable.redemptionId, coopPerkRedemptionsTable.id)
      )
      .where(inArray(coopFinancialDisputeEvidenceTable.disputeId, ids))
      .orderBy(asc(coopFinancialDisputeEvidenceTable.id)),
    db
      .select()
      .from(coopFinancialDisputeEventsTable)
      .where(inArray(coopFinancialDisputeEventsTable.disputeId, ids))
      .orderBy(asc(coopFinancialDisputeEventsTable.createdAt), asc(coopFinancialDisputeEventsTable.id)),
    db
      .select({
        row: coopLedgerAdjustmentsTable,
        creditTenantName: creditTenants.brandName,
        debitTenantName: debitTenants.brandName,
      })
      .from(coopLedgerAdjustmentsTable)
      .leftJoin(creditTenants, eq(coopLedgerAdjustmentsTable.creditTenantId, creditTenants.id))
      .leftJoin(debitTenants, eq(coopLedgerAdjustmentsTable.debitTenantId, debitTenants.id))
      .where(inArray(coopLedgerAdjustmentsTable.disputeId, ids))
      .orderBy(asc(coopLedgerAdjustmentsTable.id)),
  ]);
  return rows.map((r) => ({
    id: r.dispute.id,
    partnershipId: r.dispute.partnershipId,
    perkTitle: r.perkTitle,
    filedByTenantId: r.dispute.filedByTenantId,
    filedByTenantName: r.filedByTenantName,
    respondentTenantId: r.dispute.respondentTenantId,
    respondentTenantName: r.respondentTenantName,
    disputeType: r.dispute.disputeType,
    claimedCount: r.dispute.claimedCount,
    expectedCount: r.dispute.expectedCount,
    claimedAmount: numeric(r.dispute.claimedAmount),
    expectedAmount: numeric(r.dispute.expectedAmount),
    windowStartAt: r.dispute.windowStartAt.toISOString(),
    windowEndAt: r.dispute.windowEndAt.toISOString(),
    details: r.dispute.details,
    status: r.dispute.status,
    reconciliationSummary: r.dispute.reconciliationSummary,
    reconciliationSystemCount: r.dispute.reconciliationSystemCount,
    counterpartyResponse: r.dispute.counterpartyResponse,
    respondedAt: r.dispute.respondedAt?.toISOString() ?? null,
    ruling: r.dispute.ruling,
    ruledAgainstTenantId: r.dispute.ruledAgainstTenantId,
    escalatedAt: r.dispute.escalatedAt?.toISOString() ?? null,
    resolvedAt: r.dispute.resolvedAt?.toISOString() ?? null,
    evidence: evidence
      .filter((e) => e.row.disputeId === r.dispute.id)
      .map((e) => ({
        id: e.row.id,
        kind: e.row.kind,
        addedByTenantId: e.row.addedByTenantId,
        redemptionId: e.row.redemptionId,
        redemptionPassCode: e.redemptionPassCode ?? null,
        redemptionRedeemedAt: e.redemptionRedeemedAt?.toISOString() ?? null,
        referenceNumber: e.row.referenceNumber,
        amount: numeric(e.row.amount),
        entryDate: e.row.entryDate?.toISOString() ?? null,
        description: e.row.description,
        createdAt: e.row.createdAt.toISOString(),
      })),
    events: events
      .filter((e) => e.disputeId === r.dispute.id)
      .map((e) => ({
        id: e.id,
        eventType: e.eventType,
        actorType: e.actorType,
        actorTenantId: e.actorTenantId,
        note: e.note,
        createdAt: e.createdAt.toISOString(),
      })),
    adjustments: adjustments
      .filter((a) => a.row.disputeId === r.dispute.id)
      .map((a) => ({
        id: a.row.id,
        adjustmentType: a.row.adjustmentType,
        amount: parseFloat(a.row.amount),
        creditTenantId: a.row.creditTenantId,
        creditTenantName: a.creditTenantName ?? null,
        debitTenantId: a.row.debitTenantId,
        debitTenantName: a.debitTenantName ?? null,
        reason: a.row.reason,
        createdAt: a.row.createdAt.toISOString(),
      })),
    createdAt: r.dispute.createdAt.toISOString(),
    updatedAt: r.dispute.updatedAt.toISOString(),
  }));
}

export async function serializedFinancialDispute(id: number) {
  const rows = await financialDisputeRows().where(eq(coopFinancialDisputesTable.id, id));
  const [serialized] = await serializeFinancialDisputes(rows);
  return serialized;
}

export async function recordDisputeEvent(entry: {
  disputeId: number;
  eventType: string;
  actorType: "tenant" | "admin" | "system";
  actorTenantId?: number | null;
  note?: string | null;
}): Promise<void> {
  await db.insert(coopFinancialDisputeEventsTable).values({
    disputeId: entry.disputeId,
    eventType: entry.eventType,
    actorType: entry.actorType,
    actorTenantId: entry.actorTenantId ?? null,
    note: entry.note ?? null,
  });
}

/** Redemption count in the platform's own ledger for a partnership + window. */
export async function systemRedemptionCount(
  partnershipId: number,
  windowStartAt: Date,
  windowEndAt: Date
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(coopPerkRedemptionsTable)
    .where(
      and(
        eq(coopPerkRedemptionsTable.partnershipId, partnershipId),
        gte(coopPerkRedemptionsTable.redeemedAt, windowStartAt),
        lte(coopPerkRedemptionsTable.redeemedAt, windowEndAt)
      )
    );
  return row?.n ?? 0;
}

/**
 * Automated reconciliation: compare the claim against the platform's own
 * redemption ledger. When the system's figure confirms one party's count
 * within tolerance the ticket auto-resolves; otherwise it escalates for
 * admin mediation. Shared-expense disputes always escalate — the platform
 * holds no expense records to arbitrate with. Returns the outcome to persist.
 */
export function reconcileClaim(input: {
  disputeType: string;
  claimedCount: number | null;
  expectedCount: number | null;
  systemCount: number;
  filerName: string;
  respondentName: string;
  windowStartAt: Date;
  windowEndAt: Date;
}): { resolved: boolean; summary: string } {
  const tol = reconciliationCountTolerance();
  const window = `${input.windowStartAt.toISOString().slice(0, 10)} to ${input.windowEndAt
    .toISOString()
    .slice(0, 10)}`;
  const base =
    `Automated reconciliation: the platform's redemption ledger records ` +
    `${input.systemCount} redemption(s) for this partnership between ${window}.`;
  if (input.disputeType === "shared_expense") {
    return {
      resolved: false,
      summary:
        `${base} Shared expenses are not tracked in the platform ledger, so this ` +
        `discrepancy cannot be settled automatically and has been escalated to a platform mediator.`,
    };
  }
  const within = (v: number | null) => v != null && Math.abs(input.systemCount - v) <= tol;
  if (within(input.claimedCount)) {
    return {
      resolved: true,
      summary:
        `${base} This matches ${input.filerName}'s claimed figure of ${input.claimedCount} ` +
        `within the ${tol}-redemption tolerance, so the ticket was resolved automatically in ` +
        `favor of the platform record. No mediator action is required.`,
    };
  }
  if (within(input.expectedCount)) {
    return {
      resolved: true,
      summary:
        `${base} This matches ${input.respondentName}'s figure of ${input.expectedCount} ` +
        `within the ${tol}-redemption tolerance, so the ticket was resolved automatically in ` +
        `favor of the platform record. No mediator action is required.`,
    };
  }
  return {
    resolved: false,
    summary:
      `${base} Neither party's figure (claimed ${input.claimedCount ?? "—"}, ` +
      `counterparty ${input.expectedCount ?? "—"}) matches the platform record within the ` +
      `${tol}-redemption tolerance. The ticket has been escalated to a platform mediator.`,
  };
}

// ── Tenant co-op suspension helpers ─────────────────────────────────────────

/** IDs (from the given set) that currently have an ACTIVE co-op suspension. */
export async function activeSuspensionTenantIds(tenantIds: number[]): Promise<Set<number>> {
  if (tenantIds.length === 0) return new Set();
  const rows = await db
    .select({ tenantId: coopTenantSuspensionsTable.tenantId })
    .from(coopTenantSuspensionsTable)
    .where(
      and(
        inArray(coopTenantSuspensionsTable.tenantId, tenantIds),
        eq(coopTenantSuspensionsTable.status, "active")
      )
    );
  return new Set(rows.map((r) => r.tenantId));
}

export async function hasActiveSuspension(tenantId: number): Promise<boolean> {
  const set = await activeSuspensionTenantIds([tenantId]);
  return set.has(tenantId);
}

export function serializeSuspension(s: CoopTenantSuspension, tenantName: string) {
  return {
    id: s.id,
    tenantId: s.tenantId,
    tenantName,
    status: s.status,
    trigger: s.trigger,
    reason: s.reason,
    rulingsCount: s.rulingsCount,
    windowDays: s.windowDays,
    suspendedAt: s.suspendedAt.toISOString(),
    liftedAt: s.liftedAt?.toISOString() ?? null,
  };
}

/** Notify a tenant's business owner through the unified messaging pipeline. Never throws. */
export async function notifyTenantSafe(
  tenantId: number,
  kind: "coop_financial_dispute",
  body: string,
  context: Record<string, unknown>
): Promise<void> {
  const [settings] = await db
    .select({ publicPhone: sosSettingsTable.publicPhone })
    .from(sosSettingsTable)
    .where(eq(sosSettingsTable.tenantId, tenantId));
  await sendMessageSafe({
    tenantId,
    origin: "operational",
    kind,
    toNumber: settings?.publicPhone?.trim() || null,
    body,
    context,
  });
}

/**
 * Repeat-violator automation: whenever an admin ruling lands against a
 * tenant, count that tenant's rulings-against inside the rolling window and
 * auto-suspend its co-op participation when the threshold is crossed.
 * The partial unique index makes the insert race-safe (one active suspension
 * per tenant); losing the race means a suspension already exists, which is
 * the desired end state. Returns the created suspension, if any.
 */
export async function checkRepeatViolator(
  tenantId: number,
  triggeringDispute: CoopFinancialDispute
): Promise<CoopTenantSuspension | null> {
  const threshold = repeatViolatorThreshold();
  const windowDays = repeatViolatorWindowDays();
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ n: count() })
    .from(coopFinancialDisputesTable)
    .where(
      and(
        eq(coopFinancialDisputesTable.ruledAgainstTenantId, tenantId),
        gte(coopFinancialDisputesTable.resolvedAt, windowStart)
      )
    );
  const rulings = row?.n ?? 0;
  if (rulings < threshold) return null;
  let created: CoopTenantSuspension | undefined;
  try {
    [created] = await db
      .insert(coopTenantSuspensionsTable)
      .values({
        tenantId,
        status: "active",
        trigger: "repeat_violator",
        reason:
          `Automatic suspension: ${rulings} admin ruling(s) against this business within ` +
          `the last ${windowDays} days (threshold ${threshold}).`,
        rulingsCount: rulings,
        windowDays,
      })
      .onConflictDoNothing()
      .returning();
  } catch (err) {
    // defensive — conflict path already handled by onConflictDoNothing
    logger.error(
      { err, disputeId: triggeringDispute.id },
      "Repeat-violator auto-suspension insert failed unexpectedly",
    );
    return null;
  }
  if (!created) return null;
  await recordDisputeEvent({
    disputeId: triggeringDispute.id,
    eventType: "suspension_triggered",
    actorType: "system",
    note:
      `Co-op participation auto-suspended for repeat violations: ${rulings} ruling(s) ` +
      `against this business within ${windowDays} days (threshold ${threshold}).`,
  });
  await notifyTenantSafe(
    tenantId,
    "coop_financial_dispute",
    `Co-Op notice: your co-op participation has been suspended automatically after ` +
      `${rulings} mediation rulings against your business in the last ${windowDays} days. ` +
      `Your perks are paused and new partnerships are blocked until a platform admin reinstates you.`,
    { suspensionId: created.id, disputeId: triggeringDispute.id, trigger: "repeat_violator" }
  );
  return created;
}
