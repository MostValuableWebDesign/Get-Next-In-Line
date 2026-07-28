import {
  db,
  sosStaffMembersTable,
  coopEventsTable,
  merchantCoopPartnershipsTable,
} from "@workspace/db";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { CROSSOVER_REVENUE_WINDOW_MS } from "./coopEvents";

// ── Tip pooling & gratuity splitting ─────────────────────────────────────────
// Pure allocation math plus the participant-resolution rules used at checkout.
// Tips are captured separately from service revenue and split across the
// participating staff pool; every allocation is written to the gratuity
// ledger with strict per-staff tenant scoping.

export const TIP_SPLIT_RULES = ["equal", "percentage", "role_weighted"] as const;
export type TipSplitRule = (typeof TIP_SPLIT_RULES)[number];

export function isTipSplitRule(v: unknown): v is TipSplitRule {
  return typeof v === "string" && (TIP_SPLIT_RULES as readonly string[]).includes(v);
}

export interface TipParticipant {
  staffId: number;
  /** The STAFF MEMBER'S tenant — ledger rows are scoped to this, not the visit's tenant. */
  tenantId: number | null;
  tipPercent: number | null;
  tipRoleWeight: number | null;
}

export interface TipAllocation {
  staffId: number;
  tenantId: number | null;
  /** Money string with 2 decimals (sum of all allocations === the tip, exactly). */
  amount: string;
}

/**
 * Split a tip across participants under a rule. Exact-cent math: allocations
 * always sum to the tip precisely (largest-cumulative rounding).
 *
 * - equal: even split across the pool.
 * - percentage: proportional to each member's tipPercent (NULL/0 excluded);
 *   normalized by the pool total, so shares needn't sum to 100. Falls back to
 *   an equal split when nobody has a percentage configured.
 * - role_weighted: proportional to tipRoleWeight (NULL = weight 1; 0 excluded).
 */
export function computeTipAllocations(
  rule: TipSplitRule,
  tipAmount: number,
  participants: TipParticipant[],
): { rule: TipSplitRule; allocations: TipAllocation[] } {
  if (!(tipAmount > 0) || participants.length === 0) return { rule, allocations: [] };

  let effectiveRule = rule;
  let shares: number[];
  if (rule === "percentage") {
    shares = participants.map((p) => Math.max(0, p.tipPercent ?? 0));
    if (shares.every((s) => s === 0)) {
      effectiveRule = "equal";
      shares = participants.map(() => 1);
    }
  } else if (rule === "role_weighted") {
    shares = participants.map((p) => Math.max(0, p.tipRoleWeight ?? 1));
    if (shares.every((s) => s === 0)) {
      effectiveRule = "equal";
      shares = participants.map(() => 1);
    }
  } else {
    shares = participants.map(() => 1);
  }

  const total = shares.reduce((a, b) => a + b, 0);
  const tipCents = Math.round(tipAmount * 100);
  const allocations: TipAllocation[] = [];
  let cumShare = 0;
  let allocatedCents = 0;
  for (let i = 0; i < participants.length; i++) {
    cumShare += shares[i];
    const cumCents = Math.round((tipCents * cumShare) / total);
    const cents = cumCents - allocatedCents;
    allocatedCents = cumCents;
    if (cents <= 0) continue; // zero-share members receive no ledger row
    allocations.push({
      staffId: participants[i].staffId,
      tenantId: participants[i].tenantId,
      amount: (cents / 100).toFixed(2),
    });
  }
  return { rule: effectiveRule, allocations };
}

type StaffRow = typeof sosStaffMembersTable.$inferSelect;

function toParticipant(s: StaffRow): TipParticipant {
  return {
    staffId: s.id,
    tenantId: s.tenantId,
    tipPercent: s.tipPercent,
    tipRoleWeight: s.tipRoleWeight,
  };
}

async function activeStaffOf(tenantId: number | null): Promise<StaffRow[]> {
  return db
    .select()
    .from(sosStaffMembersTable)
    .where(
      and(
        tenantId == null
          ? isNull(sosStaffMembersTable.tenantId)
          : eq(sosStaffMembersTable.tenantId, tenantId),
        eq(sosStaffMembersTable.isActive, true),
      ),
    )
    .orderBy(sosStaffMembersTable.id);
}

/**
 * The partner tenant on a shared co-op visit, if any: the most recent
 * cross-over event at this tenant inside the attribution window whose
 * partnership is still accepted and live. Best-effort heuristic (same window
 * the crossover revenue attribution uses).
 */
export async function recentCoopPartnerTenantId(
  tenantId: number | null,
  now: Date = new Date(),
): Promise<number | null> {
  if (tenantId == null) return null;
  const cutoff = new Date(now.getTime() - CROSSOVER_REVENUE_WINDOW_MS);
  const [row] = await db
    .select({ partnerTenantId: coopEventsTable.partnerTenantId })
    .from(coopEventsTable)
    .innerJoin(
      merchantCoopPartnershipsTable,
      eq(coopEventsTable.partnershipId, merchantCoopPartnershipsTable.id),
    )
    .where(
      and(
        eq(coopEventsTable.tenantId, tenantId),
        eq(coopEventsTable.eventType, "crossover"),
        gte(coopEventsTable.occurredAt, cutoff),
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        eq(merchantCoopPartnershipsTable.isActive, true),
        eq(merchantCoopPartnershipsTable.disputeSuspended, false),
        isNull(merchantCoopPartnershipsTable.bannedAt),
      ),
    )
    .orderBy(desc(coopEventsTable.occurredAt), desc(coopEventsTable.id))
    .limit(1);
  return row?.partnerTenantId ?? null;
}

/**
 * The staff pool a checkout tip is split across: the visit tenant's active
 * staff, plus — when the visit is tied to a recent co-op crossover on a live
 * partnership — the partner tenant's active staff. Each participant carries
 * their OWN tenant id so ledger rows land on the correct tenant's ledger.
 */
export async function resolveTipParticipants(
  tenantId: number | null,
  now: Date = new Date(),
): Promise<TipParticipant[]> {
  const own = await activeStaffOf(tenantId);
  const partnerTenantId = await recentCoopPartnerTenantId(tenantId, now);
  if (partnerTenantId == null || partnerTenantId === tenantId) {
    return own.map(toParticipant);
  }
  const partner = await activeStaffOf(partnerTenantId);
  return [...own, ...partner].map(toParticipant);
}
