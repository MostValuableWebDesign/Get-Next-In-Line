import {
  db,
  merchantCoopPartnershipsTable,
  coopAttributionEventsTable,
  coopTierEventsTable,
  tenantsTable,
  sosSettingsTable,
  type MerchantCoopPartnership,
} from "@workspace/db";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { sendMessageSafe } from "./messaging";
import { logger } from "./logger";

// ── Performance-based partnership tiers ──────────────────────────────────────
// Partnership status is tied to real cross-promoted traffic. Each side may set
// a reciprocity threshold (customers the OTHER side must send over a rolling
// 30-day window). The scheduled evaluator (concierge tick) downgrades
// below-threshold partnerships from Premier to Standard, pauses zero-traffic
// partnerships entirely, and reactivates paused partnerships when traffic
// resumes. Every transition is audited in coop_tier_events and both parties
// are notified with the reason.

export const COOP_TIER_PREMIER = "premier";
export const COOP_TIER_STANDARD = "standard";

/** Default customers / rolling 30 days when a side hasn't set a threshold. */
export const DEFAULT_RECIPROCITY_THRESHOLD = 5;

/** Rolling evaluation window. */
export const TIER_WINDOW_DAYS = 30;
const TIER_WINDOW_MS = TIER_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Grace period for brand-new partnerships: nothing younger than the rolling
 * window is ever downgraded or paused (it hasn't had 30 days to earn traffic).
 */
export const TIER_GRACE_MS = TIER_WINDOW_MS;

export interface TierCounts {
  hostToPartner: number;
  partnerToHost: number;
}

export function effectiveThresholds(p: {
  hostReciprocityThreshold: number | null;
  partnerReciprocityThreshold: number | null;
}): { host: number; partner: number } {
  return {
    host: p.hostReciprocityThreshold ?? DEFAULT_RECIPROCITY_THRESHOLD,
    partner: p.partnerReciprocityThreshold ?? DEFAULT_RECIPROCITY_THRESHOLD,
  };
}

/**
 * Pure tier math for one partnership given its rolling-window counts:
 *  - zero traffic in BOTH directions → paused;
 *  - both directions meet the receiving side's threshold → premier;
 *  - anything else → standard.
 * hostReciprocityThreshold (set by the host) applies to partner→host traffic;
 * partnerReciprocityThreshold applies to host→partner traffic.
 */
export function desiredTierState(
  p: {
    hostReciprocityThreshold: number | null;
    partnerReciprocityThreshold: number | null;
  },
  counts: TierCounts
): { paused: boolean; tier: string } {
  const total = counts.hostToPartner + counts.partnerToHost;
  if (total === 0) return { paused: true, tier: COOP_TIER_STANDARD };
  const t = effectiveThresholds(p);
  const premier = counts.partnerToHost >= t.host && counts.hostToPartner >= t.partner;
  return { paused: false, tier: premier ? COOP_TIER_PREMIER : COOP_TIER_STANDARD };
}

/** Rolling-window attribution counts per partnership id, by direction. */
export async function attributionCountsSince(
  since: Date,
  partnershipIds: number[]
): Promise<Map<number, TierCounts>> {
  const out = new Map<number, TierCounts>();
  if (partnershipIds.length === 0) return out;
  const rows = await db
    .select({
      partnershipId: coopAttributionEventsTable.partnershipId,
      direction: coopAttributionEventsTable.direction,
      count: sql<number>`count(*)::int`,
    })
    .from(coopAttributionEventsTable)
    .where(
      and(
        gte(coopAttributionEventsTable.occurredAt, since),
        inArray(coopAttributionEventsTable.partnershipId, partnershipIds)
      )
    )
    .groupBy(coopAttributionEventsTable.partnershipId, coopAttributionEventsTable.direction);
  for (const r of rows) {
    const entry = out.get(r.partnershipId) ?? { hostToPartner: 0, partnerToHost: 0 };
    if (r.direction === "host_to_partner") entry.hostToPartner += r.count;
    else if (r.direction === "partner_to_host") entry.partnerToHost += r.count;
    out.set(r.partnershipId, entry);
  }
  return out;
}

/** "premier" | "standard" | "paused" label for audit rows / notifications. */
function stateLabel(tier: string, paused: boolean): string {
  return paused ? "paused" : tier;
}

/** Notify both parties of a tier transition via the unified message pipeline. */
async function notifyTierChange(
  p: MerchantCoopPartnership,
  names: { hostName: string; partnerName: string },
  reason: string
): Promise<void> {
  const parties = [
    { tenantId: p.hostTenantId, otherName: names.partnerName },
    { tenantId: p.partnerTenantId, otherName: names.hostName },
  ];
  const settings = await db
    .select({ tenantId: sosSettingsTable.tenantId, publicPhone: sosSettingsTable.publicPhone })
    .from(sosSettingsTable)
    .where(inArray(sosSettingsTable.tenantId, [p.hostTenantId, p.partnerTenantId]));
  for (const party of parties) {
    const phone = settings.find((s) => s.tenantId === party.tenantId)?.publicPhone ?? null;
    await sendMessageSafe({
      tenantId: party.tenantId,
      origin: "operational",
      kind: "coop_tier_change",
      toNumber: phone?.trim() || null,
      body: `Co-Op update: your "${p.perkTitle}" partnership with ${party.otherName} — ${reason}`,
      context: { partnershipId: p.id },
    });
  }
}

/** Write the audit row + notify both parties for one transition. */
async function applyTransition(
  p: MerchantCoopPartnership,
  names: { hostName: string; partnerName: string },
  counts: TierCounts,
  previousState: string,
  newState: string,
  reason: string,
  now: Date
): Promise<void> {
  await db.insert(coopTierEventsTable).values({
    partnershipId: p.id,
    previousState,
    newState,
    reason,
    hostToPartnerCount: counts.hostToPartner,
    partnerToHostCount: counts.partnerToHost,
    createdAt: now,
  });
  await notifyTierChange(p, names, reason);
}

export interface TierEvaluationResult {
  evaluated: number;
  paused: number;
  reactivated: number;
  downgraded: number;
  promoted: number;
}

/**
 * Evaluate every eligible partnership against its rolling 30-day attribution
 * counts and apply pause / downgrade / promote / auto-reactivate transitions.
 *
 * Idempotent: transitions are pure state diffs (desired vs. stored), so
 * re-running with unchanged traffic writes nothing and sends nothing. Callers
 * run it inside the concierge tick, which already holds the advisory lock.
 */
export async function evaluateCoopPartnershipTiers(
  now: Date = new Date()
): Promise<TierEvaluationResult> {
  const since = new Date(now.getTime() - TIER_WINDOW_MS);
  const graceCutoff = new Date(now.getTime() - TIER_GRACE_MS);
  const hostTenant = alias(tenantsTable, "tier_host_tenant");
  const partnerTenant = alias(tenantsTable, "tier_partner_tenant");
  // Only live pacts are evaluated: accepted, merchant-active, not banned, not
  // dispute-suspended, and past the new-partnership grace window.
  const rows = await db
    .select({
      partnership: merchantCoopPartnershipsTable,
      hostName: hostTenant.brandName,
      partnerName: partnerTenant.brandName,
    })
    .from(merchantCoopPartnershipsTable)
    .innerJoin(hostTenant, eq(merchantCoopPartnershipsTable.hostTenantId, hostTenant.id))
    .innerJoin(partnerTenant, eq(merchantCoopPartnershipsTable.partnerTenantId, partnerTenant.id))
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        eq(merchantCoopPartnershipsTable.isActive, true),
        eq(merchantCoopPartnershipsTable.disputeSuspended, false),
        isNull(merchantCoopPartnershipsTable.bannedAt),
        lte(merchantCoopPartnershipsTable.createdAt, graceCutoff)
      )
    );

  const counts = await attributionCountsSince(
    since,
    rows.map((r) => r.partnership.id)
  );

  const result: TierEvaluationResult = {
    evaluated: rows.length,
    paused: 0,
    reactivated: 0,
    downgraded: 0,
    promoted: 0,
  };

  for (const { partnership: p, hostName, partnerName } of rows) {
    const c = counts.get(p.id) ?? { hostToPartner: 0, partnerToHost: 0 };
    const desired = desiredTierState(p, c);
    const currentlyPaused = p.performancePausedAt != null;
    const names = { hostName, partnerName };

    if (desired.paused && !currentlyPaused) {
      // Conditional claim: only the run that flips the row writes the audit
      // trail and notifies, so concurrent/re-runs can never double-notify.
      const [claimed] = await db
        .update(merchantCoopPartnershipsTable)
        .set({ performancePausedAt: now, updatedAt: now })
        .where(
          and(
            eq(merchantCoopPartnershipsTable.id, p.id),
            isNull(merchantCoopPartnershipsTable.performancePausedAt)
          )
        )
        .returning({ id: merchantCoopPartnershipsTable.id });
      if (!claimed) continue;
      const reason = `paused automatically: no cross-promoted customers in the last ${TIER_WINDOW_DAYS} days. The perk is hidden from customers until traffic resumes or both businesses agree to reactivate.`;
      await applyTransition(p, names, c, stateLabel(p.tier, false), "paused", reason, now);
      result.paused++;
      continue;
    }

    if (!desired.paused && currentlyPaused) {
      // Traffic resumed — auto-reactivate at the computed tier.
      const [claimed] = await db
        .update(merchantCoopPartnershipsTable)
        .set({
          performancePausedAt: null,
          reactivationRequestedByTenantId: null,
          tier: desired.tier,
          updatedAt: now,
        })
        .where(
          and(
            eq(merchantCoopPartnershipsTable.id, p.id),
            eq(merchantCoopPartnershipsTable.performancePausedAt, p.performancePausedAt!)
          )
        )
        .returning({ id: merchantCoopPartnershipsTable.id });
      if (!claimed) continue;
      const reason = `reactivated: cross-promoted traffic resumed (${c.hostToPartner + c.partnerToHost} customer${c.hostToPartner + c.partnerToHost === 1 ? "" : "s"} in the last ${TIER_WINDOW_DAYS} days). Tier: ${desired.tier === COOP_TIER_PREMIER ? "Premier" : "Standard"}.`;
      await applyTransition(p, names, c, "paused", desired.tier, reason, now);
      result.reactivated++;
      continue;
    }

    if (!desired.paused && !currentlyPaused && desired.tier !== p.tier) {
      const [claimed] = await db
        .update(merchantCoopPartnershipsTable)
        .set({ tier: desired.tier, updatedAt: now })
        .where(
          and(
            eq(merchantCoopPartnershipsTable.id, p.id),
            eq(merchantCoopPartnershipsTable.tier, p.tier)
          )
        )
        .returning({ id: merchantCoopPartnershipsTable.id });
      if (!claimed) continue;
      const t = effectiveThresholds(p);
      const downgrade = desired.tier === COOP_TIER_STANDARD;
      const reason = downgrade
        ? `downgraded to Standard: below the reciprocity threshold over the last ${TIER_WINDOW_DAYS} days (host→partner ${c.hostToPartner}/${t.partner}, partner→host ${c.partnerToHost}/${t.host}).`
        : `promoted to Premier: both directions met their reciprocity thresholds over the last ${TIER_WINDOW_DAYS} days (host→partner ${c.hostToPartner}/${t.partner}, partner→host ${c.partnerToHost}/${t.host}).`;
      await applyTransition(p, names, c, p.tier, desired.tier, reason, now);
      if (downgrade) result.downgraded++;
      else result.promoted++;
    }
  }

  if (result.paused || result.reactivated || result.downgraded || result.promoted) {
    logger.info(result, "Co-op partnership tier evaluation applied transitions");
  }
  return result;
}
