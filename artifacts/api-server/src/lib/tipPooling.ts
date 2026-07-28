import {
  db,
  sosTipPoolRulesTable,
  sosTipPoolRuleParticipantsTable,
  sosVisitBundlesTable,
  sosTipPoolLedgerTable,
  sosStaffMembersTable,
  merchantCoopPartnershipsTable,
  tenantsTable,
  type SosTipPoolRule,
  type SosTipPoolRuleParticipant,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-op tip pooling — rule resolution + deterministic allocation engine.
//
// Resolution order at checkout (task contract):
//   1. Visit in a co-op bundle → the bundle partnership's active rule, but
//      ONLY while the partnership itself is accepted + active (a pending,
//      declined, paused, or deactivated partnership never splits).
//   2. Otherwise the tenant's own active group-event rule.
//   3. Otherwise no rule: the whole tip defaults to the servicing staff
//      member unchanged.
//
// Money is computed in integer cents. Each share is floored; every remainder
// cent goes to the servicing staff member's row (or the first participant
// when the servicing staff member isn't a rule participant) so the split is
// deterministic and always sums exactly to the gross tip.
// ---------------------------------------------------------------------------

export type ResolvedTipRule = {
  rule: SosTipPoolRule;
  participants: SosTipPoolRuleParticipant[];
};

/** Drizzle transaction or the root db handle. */
type Dbish = Pick<typeof db, "select" | "insert" | "update">;

function tenantMatchCol(column: any, tenantId: number | null) {
  return tenantId == null ? isNull(column) : eq(column, tenantId);
}

async function loadParticipants(
  dbx: Dbish,
  ruleId: number,
): Promise<SosTipPoolRuleParticipant[]> {
  return dbx
    .select()
    .from(sosTipPoolRuleParticipantsTable)
    .where(eq(sosTipPoolRuleParticipantsTable.ruleId, ruleId))
    .orderBy(sosTipPoolRuleParticipantsTable.id);
}

/**
 * Resolve the tip-split rule applicable to a visit at checkout.
 * Returns null when no rule applies (default: servicing staff keeps the tip).
 */
export async function resolveTipRuleForVisit(
  visit: { bundleId: number | null; tenantId: number | null },
  dbx: Dbish = db,
): Promise<ResolvedTipRule | null> {
  // 1. Bundle → partnership rule, gated on the partnership being live.
  if (visit.bundleId != null) {
    const [bundle] = await dbx
      .select({
        bundle: sosVisitBundlesTable,
        partnership: merchantCoopPartnershipsTable,
      })
      .from(sosVisitBundlesTable)
      .innerJoin(
        merchantCoopPartnershipsTable,
        eq(sosVisitBundlesTable.partnershipId, merchantCoopPartnershipsTable.id),
      )
      .where(eq(sosVisitBundlesTable.id, visit.bundleId));
    if (
      bundle &&
      bundle.partnership.status === "accepted" &&
      bundle.partnership.isActive &&
      !bundle.partnership.disputeSuspended &&
      bundle.partnership.bannedAt == null
    ) {
      const [rule] = await dbx
        .select()
        .from(sosTipPoolRulesTable)
        .where(
          and(
            eq(sosTipPoolRulesTable.scope, "partnership"),
            eq(sosTipPoolRulesTable.partnershipId, bundle.partnership.id),
            eq(sosTipPoolRulesTable.isActive, true),
          ),
        )
        .orderBy(desc(sosTipPoolRulesTable.id))
        .limit(1);
      if (rule) return { rule, participants: await loadParticipants(dbx, rule.id) };
    }
  }

  // 2. The tenant's own group-event rule.
  const [rule] = await dbx
    .select()
    .from(sosTipPoolRulesTable)
    .where(
      and(
        eq(sosTipPoolRulesTable.scope, "group_event"),
        tenantMatchCol(sosTipPoolRulesTable.tenantId, visit.tenantId),
        eq(sosTipPoolRulesTable.isActive, true),
      ),
    )
    .orderBy(desc(sosTipPoolRulesTable.id))
    .limit(1);
  if (rule) return { rule, participants: await loadParticipants(dbx, rule.id) };

  return null;
}

export type TipAllocation = {
  tenantId: number | null;
  staffId: number;
  amountCents: number;
};

/**
 * Deterministic split of `tipCents` across a rule's participants.
 * percentage → per-participant percent; equal → 1 each; role_weighted →
 * per-participant weight. Floors each share; remainder cents go to the
 * servicing staff member's row (or the first participant).
 */
export function computeTipAllocations(
  tipCents: number,
  rule: Pick<SosTipPoolRule, "splitMethod">,
  participants: Pick<SosTipPoolRuleParticipant, "tenantId" | "staffId" | "percent" | "weight">[],
  servicingStaffId: number | null,
): TipAllocation[] {
  if (participants.length === 0) return [];
  const weightOf = (p: { percent: number | null; weight: number | null }): number => {
    if (rule.splitMethod === "percentage") return p.percent ?? 0;
    if (rule.splitMethod === "role_weighted") return p.weight ?? 0;
    return 1; // equal
  };
  const weights = participants.map(weightOf);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) return [];

  const shares = participants.map((p, i) => ({
    tenantId: p.tenantId,
    staffId: p.staffId,
    amountCents: Math.floor((tipCents * weights[i]) / totalWeight),
  }));
  const remainder = tipCents - shares.reduce((a, s) => a + s.amountCents, 0);
  if (remainder > 0) {
    const target =
      shares.find((s) => servicingStaffId != null && s.staffId === servicingStaffId) ?? shares[0];
    target.amountCents += remainder;
  }
  return shares;
}

const cents = (amount: number): number => Math.round(amount * 100);
const dollars = (c: number): string => (c / 100).toFixed(2);

/**
 * Snapshot of the rule terms in force at checkout, stored on every ledger
 * row so history stays interpretable after rule edits or deletion.
 */
export function ruleSnapshotOf(resolved: ResolvedTipRule): unknown {
  return {
    ruleId: resolved.rule.id,
    scope: resolved.rule.scope,
    partnershipId: resolved.rule.partnershipId,
    splitMethod: resolved.rule.splitMethod,
    participants: resolved.participants.map((p) => ({
      tenantId: p.tenantId,
      staffId: p.staffId,
      role: p.role,
      percent: p.percent,
      weight: p.weight,
    })),
  };
}

/**
 * Compute the allocation plan for a tip on a visit (shared by the checkout
 * write path and the read-only preview endpoint).
 */
export async function planTipAllocation(
  visit: { bundleId: number | null; tenantId: number | null },
  tipAmount: number,
  servicingStaffId: number | null,
  dbx: Dbish = db,
): Promise<{ resolved: ResolvedTipRule | null; allocations: TipAllocation[] }> {
  const tipCents = cents(tipAmount);
  const resolved = await resolveTipRuleForVisit(visit, dbx);
  if (resolved) {
    const allocations = computeTipAllocations(
      tipCents,
      resolved.rule,
      resolved.participants,
      servicingStaffId,
    );
    if (allocations.length > 0) return { resolved, allocations };
  }
  // Default: the servicing staff member keeps the whole tip unchanged.
  if (servicingStaffId != null) {
    return {
      resolved: null,
      allocations: [{ tenantId: visit.tenantId, staffId: servicingStaffId, amountCents: tipCents }],
    };
  }
  return { resolved: null, allocations: [] };
}

/**
 * Write the immutable gratuity ledger rows for a checkout tip. Called inside
 * the same transaction as the visit's check_out update so the ledger is
 * atomic with the checkout. Returns the number of rows written.
 */
export async function writeGratuityLedger(
  dbx: Dbish,
  visit: { id: number; tenantId: number | null; bundleId: number | null },
  tipAmount: number,
  servicingStaffId: number | null,
): Promise<number> {
  const { resolved, allocations } = await planTipAllocation(
    visit,
    tipAmount,
    servicingStaffId,
    dbx,
  );
  if (allocations.length === 0) return 0;
  const gross = tipAmount.toFixed(2);
  await dbx.insert(sosTipPoolLedgerTable).values(
    allocations.map((a) => ({
      visitId: visit.id,
      sourceTenantId: visit.tenantId,
      recipientTenantId: a.tenantId,
      recipientStaffId: a.staffId,
      grossTip: gross,
      allocatedShare: dollars(a.amountCents),
      ruleId: resolved?.rule.id ?? null,
      ruleSnapshot: resolved ? ruleSnapshotOf(resolved) : null,
    })),
  );
  return allocations.length;
}

/** Staff + tenant display names for a set of allocations (preview surface). */
export async function describeAllocations(allocations: TipAllocation[]) {
  const staffIds = [...new Set(allocations.map((a) => a.staffId))];
  const tenantIds = [...new Set(allocations.map((a) => a.tenantId).filter((x): x is number => x != null))];
  const [staff, tenants] = await Promise.all([
    staffIds.length
      ? db
          .select({ id: sosStaffMembersTable.id, name: sosStaffMembersTable.name })
          .from(sosStaffMembersTable)
          .where(inArray(sosStaffMembersTable.id, staffIds))
      : Promise.resolve([] as { id: number; name: string }[]),
    tenantIds.length
      ? db
          .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
          .from(tenantsTable)
          .where(inArray(tenantsTable.id, tenantIds))
      : Promise.resolve([] as { id: number; brandName: string }[]),
  ]);
  const staffName = new Map(staff.map((s) => [s.id, s.name]));
  const tenantName = new Map(tenants.map((t) => [t.id, t.brandName]));
  return allocations.map((a) => ({
    tenantId: a.tenantId,
    tenantName: a.tenantId == null ? null : (tenantName.get(a.tenantId) ?? null),
    staffId: a.staffId,
    staffName: staffName.get(a.staffId) ?? "Unknown staff",
    amount: a.amountCents / 100,
  }));
}
