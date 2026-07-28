import {
  db,
  tenantsTable,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  coopPartnerRatingsTable,
  coopReputationStatesTable,
  coopReputationEventsTable,
  type CoopReputationState,
} from "@workspace/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { sendMessageSafe } from "./messaging";
import { logger } from "./logger";

// ── Co-op Review & Reputation Shield ─────────────────────────────────────────
// Internal B2B rating loop: merchants rate partners (reliability,
// professionalism, mutual traffic value, 1–5 each) strictly inside the
// partner-management dashboard. A recency-weighted reputation score per
// tenant drives automatic enforcement: flag below threshold (owner alert),
// decouple after a grace window (partnerships deactivated + hidden from
// discovery), auto-clear flags on recovery, admin-only reinstatement after a
// decouple. NOTHING here may ever reach public landing pages, customer perk
// surfaces, or the customer review system (sos_reviews).

/** Rolling period: one rating per rater per partner; re-rating inside the
 * period updates the current rating, a new period supersedes it. */
export const RATING_PERIOD_DAYS = 30;

/** Minimum distinct raters before a reputation score counts at all. */
export const REPUTATION_MIN_RATERS = envInt("COOP_REPUTATION_MIN_RATERS", 2);

/** Overall score (1–5) below which a tenant is flagged. */
export const REPUTATION_FLAG_THRESHOLD = envFloat("COOP_REPUTATION_THRESHOLD", 2.5);

/** Grace window after flagging before an automatic decouple. */
export const REPUTATION_GRACE_MS = envFloat("COOP_REPUTATION_GRACE_DAYS", 3) * 86_400_000;

/** Recency half-life: a rating this many days old counts half as much. */
export const RECENCY_HALF_LIFE_DAYS = 30;

function envInt(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
function envFloat(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface ReputationDimensions {
  reliability: number;
  professionalism: number;
  trafficValue: number;
}

export interface ReputationComputation {
  /** Recency-weighted overall average across the three dimensions, rounded
   * to 2 decimals. Null until the minimum-rater floor is met. */
  score: number | null;
  raterCount: number;
  /** Per-dimension recency-weighted averages (null with the score). */
  dimensions: ReputationDimensions | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Compute the reputation for a set of tenants from their CURRENT received
 * ratings (one per rater), weighted by recency (exponential half-life).
 */
export async function computeReputations(
  tenantIds: number[],
  now: Date = new Date(),
): Promise<Map<number, ReputationComputation>> {
  const out = new Map<number, ReputationComputation>();
  for (const id of tenantIds) {
    out.set(id, { score: null, raterCount: 0, dimensions: null });
  }
  if (tenantIds.length === 0) return out;
  const rows = await db
    .select()
    .from(coopPartnerRatingsTable)
    .where(
      and(
        inArray(coopPartnerRatingsTable.ratedTenantId, tenantIds),
        eq(coopPartnerRatingsTable.isCurrent, true),
      ),
    );
  const byTenant = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byTenant.get(r.ratedTenantId) ?? [];
    list.push(r);
    byTenant.set(r.ratedTenantId, list);
  }
  for (const [tenantId, ratings] of byTenant) {
    const raterCount = new Set(ratings.map((r) => r.raterTenantId)).size;
    let wSum = 0;
    let rel = 0;
    let pro = 0;
    let traf = 0;
    for (const r of ratings) {
      const ageDays = Math.max(0, (now.getTime() - r.updatedAt.getTime()) / 86_400_000);
      const w = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
      wSum += w;
      rel += w * r.reliability;
      pro += w * r.professionalism;
      traf += w * r.trafficValue;
    }
    if (wSum <= 0 || raterCount < REPUTATION_MIN_RATERS) {
      out.set(tenantId, { score: null, raterCount, dimensions: null });
      continue;
    }
    const dimensions = {
      reliability: round2(rel / wSum),
      professionalism: round2(pro / wSum),
      trafficValue: round2(traf / wSum),
    };
    const score = round2(
      (dimensions.reliability + dimensions.professionalism + dimensions.trafficValue) / 3,
    );
    out.set(tenantId, { score, raterCount, dimensions });
  }
  return out;
}

/** Tenants currently decoupled by the Reputation Shield. Directory,
 * suggestions, perk serving, and redemption reads must all exclude them. */
export async function decoupledTenantIdSet(): Promise<Set<number>> {
  const rows = await db
    .select({ tenantId: coopReputationStatesTable.tenantId })
    .from(coopReputationStatesTable)
    .where(eq(coopReputationStatesTable.status, "decoupled"));
  return new Set(rows.map((r) => r.tenantId));
}

async function recordEvent(
  tenantId: number,
  eventType: "flagged" | "decoupled" | "flag_cleared" | "reinstated",
  score: number | null,
  details?: Record<string, unknown>,
  now: Date = new Date(),
): Promise<void> {
  await db.insert(coopReputationEventsTable).values({
    tenantId,
    eventType,
    score: score == null ? null : String(score),
    details: details ?? null,
    createdAt: now,
  });
}

async function alertOwner(tenantId: number, body: string): Promise<void> {
  const [settings] = await db
    .select({ publicPhone: sosSettingsTable.publicPhone })
    .from(sosSettingsTable)
    .where(eq(sosSettingsTable.tenantId, tenantId));
  await sendMessageSafe({
    tenantId,
    origin: "operational",
    kind: "coop_reputation",
    toNumber: settings?.publicPhone?.trim() || null,
    body,
  });
}

export interface ReputationEnforcementResult {
  flagged: number;
  decoupled: number;
  cleared: number;
}

/**
 * Periodic enforcement sweep (concierge worker): recompute scores, flag
 * tenants that crossed below the threshold (with an owner alert), decouple
 * tenants still below threshold after the grace window (deactivate their
 * accepted partnerships and record which, so a reinstate restores exactly
 * those), and auto-clear flags on recovery. Decoupled tenants only come back
 * through an admin reinstate. Idempotent per state transition.
 */
export async function runReputationEnforcement(
  now: Date = new Date(),
): Promise<ReputationEnforcementResult> {
  const result: ReputationEnforcementResult = { flagged: 0, decoupled: 0, cleared: 0 };
  // Every tenant with any current received rating, plus any tenant that
  // already has a state row (so recoveries clear even after ratings vanish).
  const ratedRows = await db
    .selectDistinct({ tenantId: coopPartnerRatingsTable.ratedTenantId })
    .from(coopPartnerRatingsTable)
    .where(eq(coopPartnerRatingsTable.isCurrent, true));
  const stateRows = await db.select().from(coopReputationStatesTable);
  const stateByTenant = new Map(stateRows.map((s) => [s.tenantId, s]));
  const tenantIds = [
    ...new Set([...ratedRows.map((r) => r.tenantId), ...stateRows.map((s) => s.tenantId)]),
  ];
  if (tenantIds.length === 0) return result;

  const [nameRows, computed] = await Promise.all([
    db
      .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, tenantIds)),
    computeReputations(tenantIds, now),
  ]);
  const names = new Map(nameRows.map((t) => [t.id, t.brandName]));

  for (const tenantId of tenantIds) {
    const comp = computed.get(tenantId)!;
    const state = stateByTenant.get(tenantId);
    const scoreStr = comp.score == null ? null : String(comp.score);
    const below = comp.score != null && comp.score < REPUTATION_FLAG_THRESHOLD;

    const upsertState = async (patch: Partial<typeof coopReputationStatesTable.$inferInsert>) => {
      await db
        .insert(coopReputationStatesTable)
        .values({
          tenantId,
          score: scoreStr,
          raterCount: comp.raterCount,
          status: "ok",
          updatedAt: now,
          ...patch,
        })
        .onConflictDoUpdate({
          target: coopReputationStatesTable.tenantId,
          set: { score: scoreStr, raterCount: comp.raterCount, updatedAt: now, ...patch },
        });
    };

    if (below) {
      if (state?.status === "decoupled") {
        await upsertState({ status: "decoupled" });
      } else if (state?.status === "flagged") {
        const flaggedAt = state.flaggedAt ?? now;
        if (flaggedAt.getTime() + REPUTATION_GRACE_MS <= now.getTime()) {
          // Grace window elapsed and still below threshold — decouple.
          const deactivated = await db
            .update(merchantCoopPartnershipsTable)
            .set({ isActive: false, updatedAt: now })
            .where(
              and(
                eq(merchantCoopPartnershipsTable.status, "accepted"),
                eq(merchantCoopPartnershipsTable.isActive, true),
                or(
                  eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
                  eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId),
                ),
              ),
            )
            .returning({ id: merchantCoopPartnershipsTable.id });
          await upsertState({ status: "decoupled", decoupledAt: now });
          await recordEvent(
            tenantId,
            "decoupled",
            comp.score,
            { partnershipIds: deactivated.map((p) => p.id) },
            now,
          );
          await alertOwner(
            tenantId,
            `Get Next In Line Co-Op notice for ${names.get(tenantId) ?? "your business"}: ` +
              `your partner reliability score stayed below the network standard after the grace window, ` +
              `so your co-op partnerships have been paused and your business is hidden from partner discovery. ` +
              `A platform admin can reinstate you — reply to this number or contact support.`,
          );
          result.decoupled += 1;
          logger.warn({ tenantId, score: comp.score }, "Reputation Shield decoupled tenant");
        } else {
          await upsertState({ status: "flagged" });
        }
      } else {
        // ok / no state → flag with an owner warning.
        await upsertState({ status: "flagged", flaggedAt: now, decoupledAt: null });
        await recordEvent(tenantId, "flagged", comp.score, undefined, now);
        await alertOwner(
          tenantId,
          `Get Next In Line Co-Op warning for ${names.get(tenantId) ?? "your business"}: ` +
            `partners have rated recent experiences below the network reliability standard ` +
            `(score ${comp.score?.toFixed(2)}). Please honor valid perks and respond to partners — ` +
            `if the score stays low, your co-op partnerships will be paused automatically.`,
        );
        result.flagged += 1;
        logger.warn({ tenantId, score: comp.score }, "Reputation Shield flagged tenant");
      }
    } else {
      // Recovered (or insufficient raters): flags clear automatically;
      // decoupled stays until an admin reinstates.
      if (state?.status === "flagged") {
        await upsertState({ status: "ok", flaggedAt: null });
        await recordEvent(tenantId, "flag_cleared", comp.score, undefined, now);
        result.cleared += 1;
      } else if (state?.status === "decoupled") {
        await upsertState({ status: "decoupled" });
      } else if (state) {
        await upsertState({ status: "ok" });
      } else if (comp.raterCount > 0) {
        await upsertState({ status: "ok" });
      }
    }
  }
  return result;
}

/**
 * Admin reinstate after a Reputation Shield decouple: reactivates exactly the
 * partnerships the decouple deactivated (still-accepted, unbanned ones only),
 * restores directory visibility, clears the flag/decouple state, and records
 * an audited `reinstated` event. Returns the updated state, or null when the
 * tenant has no reputation state or is not decoupled.
 */
export async function reinstateReputation(
  tenantId: number,
  now: Date = new Date(),
): Promise<CoopReputationState | null> {
  const [state] = await db
    .select()
    .from(coopReputationStatesTable)
    .where(eq(coopReputationStatesTable.tenantId, tenantId));
  if (!state || state.status !== "decoupled") return null;

  // The decouple event recorded which partnerships it deactivated.
  const events = await db
    .select()
    .from(coopReputationEventsTable)
    .where(
      and(
        eq(coopReputationEventsTable.tenantId, tenantId),
        eq(coopReputationEventsTable.eventType, "decoupled"),
      ),
    )
    .orderBy(sql`${coopReputationEventsTable.createdAt} desc`)
    .limit(1);
  const ids = (events[0]?.details?.partnershipIds as number[] | undefined) ?? [];
  if (ids.length > 0) {
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ isActive: true, updatedAt: now })
      .where(
        and(
          inArray(merchantCoopPartnershipsTable.id, ids),
          eq(merchantCoopPartnershipsTable.status, "accepted"),
          isNull(merchantCoopPartnershipsTable.bannedAt),
        ),
      );
  }
  const [updated] = await db
    .update(coopReputationStatesTable)
    .set({ status: "ok", flaggedAt: null, decoupledAt: null, updatedAt: now })
    .where(eq(coopReputationStatesTable.tenantId, tenantId))
    .returning();
  await recordEvent(
    tenantId,
    "reinstated",
    state.score == null ? null : Number(state.score),
    { reactivatedPartnershipIds: ids },
    now,
  );
  logger.info({ tenantId }, "Reputation Shield reinstated tenant");
  return updated;
}
