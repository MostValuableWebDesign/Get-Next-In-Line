import { db, coopTrafficEventsTable } from "@workspace/db";
import { and, eq, gte, or, sql } from "drizzle-orm";

// ── Co-op cross-promotion traffic ledger ─────────────────────────────────────
// Records and aggregates per-partnership traffic events. Every event is
// strictly attributed: the receiving tenant is the party the traffic/benefit
// flowed toward; the source tenant is the party on whose surface the event
// originated. For a given tenant, inbound = events where it is the receiver,
// outbound = events where the other party is.

export type CoopTrafficEventType = "perk_impression" | "perk_click" | "code_validation";

/**
 * Record a traffic event. Never throws — ledger accounting must not break the
 * customer-facing surface (landing page, checkout) that triggered it.
 */
export async function recordCoopTrafficEvent(event: {
  partnershipId: number;
  receivingTenantId: number;
  sourceTenantId: number | null;
  eventType: CoopTrafficEventType;
}): Promise<void> {
  try {
    await db.insert(coopTrafficEventsTable).values(event);
  } catch (err) {
    console.error("coop traffic event not recorded:", err);
  }
}

export interface CoopTrafficCounts {
  inbound: number;
  outbound: number;
}

export interface PartnershipTraffic {
  window: CoopTrafficCounts;
  evaluation: CoopTrafficCounts;
  allTime: CoopTrafficCounts;
}

/**
 * Windowed + all-time inbound/outbound counts for a set of partnerships, from
 * the given tenant's point of view. Returns a map keyed by partnership id;
 * partnerships with no events are absent (treat as zeroes).
 *
 * `windowDays` drives the displayed recent-window counts; `evaluationDays`
 * drives the counts the reciprocity threshold is judged against (they are
 * often the same — both are computed in one grouped query either way).
 */
export async function getTrafficByPartnership(
  tenantId: number,
  partnershipIds: number[],
  windowDays: number,
  evaluationDays: number,
): Promise<Map<number, PartnershipTraffic>> {
  const out = new Map<number, PartnershipTraffic>();
  if (partnershipIds.length === 0) return out;
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const evalStart = new Date(Date.now() - evaluationDays * 24 * 60 * 60 * 1000);
  const isInbound = eq(coopTrafficEventsTable.receivingTenantId, tenantId);
  const rows = await db
    .select({
      partnershipId: coopTrafficEventsTable.partnershipId,
      windowIn: sql<number>`count(*) filter (where ${coopTrafficEventsTable.occurredAt} >= ${windowStart} and ${isInbound})`,
      windowOut: sql<number>`count(*) filter (where ${coopTrafficEventsTable.occurredAt} >= ${windowStart} and not ${isInbound})`,
      evalIn: sql<number>`count(*) filter (where ${coopTrafficEventsTable.occurredAt} >= ${evalStart} and ${isInbound})`,
      evalOut: sql<number>`count(*) filter (where ${coopTrafficEventsTable.occurredAt} >= ${evalStart} and not ${isInbound})`,
      allIn: sql<number>`count(*) filter (where ${isInbound})`,
      allOut: sql<number>`count(*) filter (where not ${isInbound})`,
    })
    .from(coopTrafficEventsTable)
    .where(
      and(
        or(...partnershipIds.map((id) => eq(coopTrafficEventsTable.partnershipId, id))),
      ),
    )
    .groupBy(coopTrafficEventsTable.partnershipId);
  for (const r of rows) {
    out.set(r.partnershipId, {
      window: { inbound: Number(r.windowIn), outbound: Number(r.windowOut) },
      evaluation: { inbound: Number(r.evalIn), outbound: Number(r.evalOut) },
      allTime: { inbound: Number(r.allIn), outbound: Number(r.allOut) },
    });
  }
  return out;
}

/** |in − out| / max(in, out) × 100; 0 when there is no traffic at all. */
export function disparityPercent(c: CoopTrafficCounts): number {
  const max = Math.max(c.inbound, c.outbound);
  if (max === 0) return 0;
  return (Math.abs(c.inbound - c.outbound) / max) * 100;
}
