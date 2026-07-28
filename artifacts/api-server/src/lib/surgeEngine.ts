import {
  db,
  merchantCoopPartnershipsTable,
  coopSurgeRulesTable,
  coopSurgeActivationsTable,
  tenantsTable,
  type CoopSurgeRule,
  type CoopSurgeActivation,
  type MerchantCoopPartnership,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { computeCapacityStatus } from "./capacityStatus";
import { isBlockedPair, isolationPartnersOf, loadCoopProfiles } from "./coopFirewall";
import { logger } from "./logger";

// ── Co-op surge traffic-routing engine ───────────────────────────────────────
// Periodically evaluates per-partnership surge rules: when the owner (busy)
// tenant's live capacity signals hit a rule's trigger, the partnership perk's
// discount is boosted for the rule's window (an activation row); the boost
// reverts automatically when the window ends or the wait normalizes. Runs on
// the concierge worker tick under its advisory lock.

export const SURGE_END_WINDOW = "window_ended";
export const SURGE_END_NORMALIZED = "normalized";
export const SURGE_END_RULE_DISABLED = "rule_disabled";

export function partnershipServesPerk(p: MerchantCoopPartnership): boolean {
  return (
    p.status === "accepted" && p.isActive && !p.disputeSuspended && p.bannedAt == null
  );
}

/** True when `now`'s local hour falls inside the rule's optional window. */
export function withinRuleHours(rule: CoopSurgeRule, now: Date): boolean {
  if (rule.windowStartHour == null || rule.windowEndHour == null) return true;
  const h = now.getHours();
  const start = rule.windowStartHour;
  const end = rule.windowEndHour;
  if (start === end) return true; // degenerate 24h window
  // Window may wrap midnight (e.g. 22 → 4).
  return start < end ? h >= start && h < end : h >= start || h < end;
}

interface TriggerCheck {
  fired: boolean;
  reason: string;
}

async function checkTrigger(rule: CoopSurgeRule, now: Date): Promise<TriggerCheck> {
  const cap = await computeCapacityStatus(rule.ownerTenantId, now);
  if (rule.triggerType === "wait_minutes") {
    const threshold = rule.waitThresholdMinutes ?? 0;
    if (threshold > 0 && cap.waitMinutes >= threshold) {
      return {
        fired: true,
        reason: `Live wait ${cap.waitMinutes} min reached the ${threshold} min threshold`,
      };
    }
    return { fired: false, reason: "" };
  }
  // at_capacity
  if (cap.status === "busy") {
    return {
      fired: true,
      reason:
        cap.source === "manual"
          ? "Business flipped its live status to at capacity"
          : "Business reached capacity (live signals)",
    };
  }
  return { fired: false, reason: "" };
}

/**
 * Activate boosts for rules whose triggers fire. The partial unique index on
 * (ruleId) WHERE ended_at IS NULL is the double-activation lock — a
 * concurrent tick's duplicate insert is swallowed by onConflictDoNothing.
 * Industry-barrier pairs are excluded again here as defense in depth.
 * Returns the number of activations created.
 */
export async function activateSurgeBoosts(now: Date = new Date()): Promise<number> {
  const rows = await db
    .select({ rule: coopSurgeRulesTable, partnership: merchantCoopPartnershipsTable })
    .from(coopSurgeRulesTable)
    .innerJoin(
      merchantCoopPartnershipsTable,
      eq(coopSurgeRulesTable.partnershipId, merchantCoopPartnershipsTable.id),
    )
    .where(eq(coopSurgeRulesTable.isActive, true));

  let activated = 0;
  for (const { rule, partnership } of rows) {
    if (!partnershipServesPerk(partnership)) continue;
    if (!withinRuleHours(rule, now)) continue;

    // Live-activation short-circuit before the (heavier) trigger computation.
    const [live] = await db
      .select({ id: coopSurgeActivationsTable.id })
      .from(coopSurgeActivationsTable)
      .where(
        and(eq(coopSurgeActivationsTable.ruleId, rule.id), isNull(coopSurgeActivationsTable.endedAt)),
      )
      .limit(1);
    if (live) continue;

    // Industry-barrier backstop: a pair that became competitors/isolated
    // after the rule was created never gets a boost.
    const otherTenantId =
      partnership.hostTenantId === rule.ownerTenantId
        ? partnership.partnerTenantId
        : partnership.hostTenantId;
    const [profiles, isolated] = await Promise.all([
      loadCoopProfiles([rule.ownerTenantId, otherTenantId]),
      isolationPartnersOf(rule.ownerTenantId),
    ]);
    const mine = profiles.get(rule.ownerTenantId);
    const theirs = profiles.get(otherTenantId);
    if (mine && theirs && isBlockedPair(mine, theirs, isolated.has(otherTenantId))) continue;

    const trigger = await checkTrigger(rule, now);
    if (!trigger.fired) continue;

    const [created] = await db
      .insert(coopSurgeActivationsTable)
      .values({
        ruleId: rule.id,
        partnershipId: rule.partnershipId,
        ownerTenantId: rule.ownerTenantId,
        baseDiscountPercent: rule.baseDiscountPercent,
        boostedDiscountPercent: rule.boostedDiscountPercent,
        triggerReason: trigger.reason,
        activatedAt: now,
        expiresAt: new Date(now.getTime() + rule.boostDurationMinutes * 60_000),
      })
      .onConflictDoNothing()
      .returning({ id: coopSurgeActivationsTable.id });
    if (created) {
      activated++;
      logger.info(
        { ruleId: rule.id, partnershipId: rule.partnershipId, reason: trigger.reason },
        "Surge boost activated",
      );
    }
  }
  return activated;
}

/**
 * End live activations whose window has passed, whose rule was disabled, or
 * whose trigger no longer fires (wait normalized / no longer at capacity).
 * Returns the number ended. Idempotent.
 */
export async function expireSurgeBoosts(now: Date = new Date()): Promise<number> {
  // 1) Hard expiry: window ended.
  const windowEnded = await db
    .update(coopSurgeActivationsTable)
    .set({ endedAt: now, endReason: SURGE_END_WINDOW })
    .where(
      and(
        isNull(coopSurgeActivationsTable.endedAt),
        lte(coopSurgeActivationsTable.expiresAt, now),
      ),
    )
    .returning({ id: coopSurgeActivationsTable.id });

  // 2) Condition normalized (or rule disabled) before the window ended.
  const liveRows = await db
    .select({ activation: coopSurgeActivationsTable, rule: coopSurgeRulesTable })
    .from(coopSurgeActivationsTable)
    .innerJoin(coopSurgeRulesTable, eq(coopSurgeActivationsTable.ruleId, coopSurgeRulesTable.id))
    .where(isNull(coopSurgeActivationsTable.endedAt));

  let normalized = 0;
  for (const { activation, rule } of liveRows) {
    let endReason: string | null = null;
    if (!rule.isActive) {
      endReason = SURGE_END_RULE_DISABLED;
    } else {
      const trigger = await checkTrigger(rule, now);
      if (!trigger.fired) endReason = SURGE_END_NORMALIZED;
    }
    if (endReason == null) continue;
    const [ended] = await db
      .update(coopSurgeActivationsTable)
      .set({ endedAt: now, endReason })
      .where(
        and(eq(coopSurgeActivationsTable.id, activation.id), isNull(coopSurgeActivationsTable.endedAt)),
      )
      .returning({ id: coopSurgeActivationsTable.id });
    if (ended) normalized++;
  }

  const total = windowEnded.length + normalized;
  if (total > 0) {
    logger.info({ windowEnded: windowEnded.length, normalized }, "Surge boosts reverted");
  }
  return total;
}

/** One full surge sweep: expiries first (so a re-fire can re-activate), then activations. */
export async function runSurgeSweep(
  now: Date = new Date(),
): Promise<{ activated: number; ended: number }> {
  const ended = await expireSurgeBoosts(now);
  const activated = await activateSurgeBoosts(now);
  return { activated, ended };
}

// ── Read helpers for perk surfaces & the hub ────────────────────────────────

export interface SurgeBoostInfo {
  baseDiscountPercent: number;
  boostedDiscountPercent: number;
  expiresAt: Date;
}

/**
 * Live surge boosts keyed by partnershipId for a set of partnerships. When a
 * partnership somehow has multiple live boosts (multiple rules), the highest
 * boosted discount wins.
 */
export async function liveSurgeBoostsByPartnership(
  partnershipIds: number[],
  now: Date = new Date(),
): Promise<Map<number, SurgeBoostInfo>> {
  const out = new Map<number, SurgeBoostInfo>();
  if (partnershipIds.length === 0) return out;
  const rows = await db
    .select()
    .from(coopSurgeActivationsTable)
    .where(
      and(
        inArray(coopSurgeActivationsTable.partnershipId, partnershipIds),
        isNull(coopSurgeActivationsTable.endedAt),
      ),
    );
  for (const a of rows) {
    if (a.expiresAt.getTime() <= now.getTime()) continue; // stale, sweep pending
    const prev = out.get(a.partnershipId);
    if (!prev || a.boostedDiscountPercent > prev.boostedDiscountPercent) {
      out.set(a.partnershipId, {
        baseDiscountPercent: a.baseDiscountPercent,
        boostedDiscountPercent: a.boostedDiscountPercent,
        expiresAt: a.expiresAt,
      });
    }
  }
  return out;
}

/** Activations (live + recent history) visible to a tenant — either side of the partnership. */
export async function surgeActivationsForTenant(
  tenantId: number,
  limit = 25,
): Promise<
  Array<{
    activation: CoopSurgeActivation;
    rule: CoopSurgeRule | null;
    partnership: MerchantCoopPartnership;
    hostTenantName: string;
    partnerTenantName: string;
  }>
> {
  const hostTenant = alias(tenantsTable, "surge_host_tenant");
  const partnerTenant = alias(tenantsTable, "surge_partner_tenant");
  const rows = await db
    .select({
      activation: coopSurgeActivationsTable,
      rule: coopSurgeRulesTable,
      partnership: merchantCoopPartnershipsTable,
      hostTenantName: hostTenant.brandName,
      partnerTenantName: partnerTenant.brandName,
    })
    .from(coopSurgeActivationsTable)
    .leftJoin(coopSurgeRulesTable, eq(coopSurgeActivationsTable.ruleId, coopSurgeRulesTable.id))
    .innerJoin(
      merchantCoopPartnershipsTable,
      eq(coopSurgeActivationsTable.partnershipId, merchantCoopPartnershipsTable.id),
    )
    .innerJoin(hostTenant, eq(merchantCoopPartnershipsTable.hostTenantId, hostTenant.id))
    .innerJoin(partnerTenant, eq(merchantCoopPartnershipsTable.partnerTenantId, partnerTenant.id))
    .where(
      or(
        eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
        eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId),
      ),
    )
    .orderBy(desc(coopSurgeActivationsTable.activatedAt), desc(coopSurgeActivationsTable.id))
    .limit(limit);
  return rows;
}
