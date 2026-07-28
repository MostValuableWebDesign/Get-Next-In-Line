import {
  db,
  sosSettingsTable,
  sosVisitsTable,
  sosResourcesTable,
  sosAppointmentsTable,
} from "@workspace/db";
import { and, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";

// ── Live capacity status ─────────────────────────────────────────────────────
// A business's broadcastable "how busy are we right now" signal, shown on the
// co-op directory and public booking surfaces, and consumed by the surge
// traffic-routing engine. A manual override (with optional expiry) always
// wins; otherwise the status derives from live operational signals:
//  - current queue wait estimates (max estimatedWaitMinutes on active visits)
//  - today's booked appointments vs. the configured daily capacity threshold
//  - resource occupancy (occupied / total resources)

export type CapacityStatus = "available" | "moderate" | "busy";

export const CAPACITY_STATUSES: readonly CapacityStatus[] = [
  "available",
  "moderate",
  "busy",
];

/** Wait minutes at/above which the automatic status is "busy". */
export const BUSY_WAIT_MINUTES = 45;
/** Wait minutes at/above which the automatic status is at least "moderate". */
export const MODERATE_WAIT_MINUTES = 20;

const QUEUE_STATUSES = ["checked_in", "queued", "assigned", "notified"] as const;

export interface CapacityStatusResult {
  status: CapacityStatus;
  /** manual — merchant override in force; auto — derived from live signals. */
  source: "manual" | "auto";
  /** Highest live wait estimate (minutes) among queued visits; 0 when idle. */
  waitMinutes: number;
  /** Non-cancelled appointments starting today. */
  appointmentsToday: number;
  /** Configured daily capacity threshold (null = none). */
  capacityThreshold: number | null;
  /** When the manual override expires (null = holds until cleared). */
  overrideExpiresAt: Date | null;
}

function isCapacityStatus(v: string): v is CapacityStatus {
  return (CAPACITY_STATUSES as readonly string[]).includes(v);
}

/**
 * Compute the live capacity status for a tenant. Reads the tenant's settings
 * row directly; a tenant with no settings row gets a plain automatic status.
 */
export async function computeCapacityStatus(
  tenantId: number,
  now: Date = new Date(),
): Promise<CapacityStatusResult> {
  const [settings] = await db
    .select({
      capacityThreshold: sosSettingsTable.capacityThreshold,
      capacityStatusOverride: sosSettingsTable.capacityStatusOverride,
      capacityOverrideExpiresAt: sosSettingsTable.capacityOverrideExpiresAt,
    })
    .from(sosSettingsTable)
    .where(eq(sosSettingsTable.tenantId, tenantId));

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  const [waitRows, apptRows, resources] = await Promise.all([
    db
      .select({
        maxWait: sql<number | null>`max(${sosVisitsTable.estimatedWaitMinutes})`,
      })
      .from(sosVisitsTable)
      .where(
        and(
          eq(sosVisitsTable.tenantId, tenantId),
          inArray(sosVisitsTable.status, [...QUEUE_STATUSES]),
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(sosAppointmentsTable)
      .where(
        and(
          eq(sosAppointmentsTable.tenantId, tenantId),
          gte(sosAppointmentsTable.startsAt, startOfDay),
          lt(sosAppointmentsTable.startsAt, endOfDay),
          ne(sosAppointmentsTable.status, "cancelled"),
        ),
      ),
    db
      .select({ status: sosResourcesTable.status })
      .from(sosResourcesTable)
      .where(eq(sosResourcesTable.tenantId, tenantId)),
  ]);

  const waitMinutes = Number(waitRows[0]?.maxWait ?? 0) || 0;
  const appointmentsToday = apptRows[0]?.n ?? 0;
  const capacityThreshold = settings?.capacityThreshold ?? null;

  // Manual override wins while it hasn't expired.
  const overrideRaw = settings?.capacityStatusOverride?.trim() ?? "";
  const overrideExpiresAt = settings?.capacityOverrideExpiresAt ?? null;
  const overrideLive =
    overrideRaw !== "" &&
    isCapacityStatus(overrideRaw) &&
    (overrideExpiresAt == null || overrideExpiresAt.getTime() > now.getTime());
  if (overrideLive) {
    return {
      status: overrideRaw as CapacityStatus,
      source: "manual",
      waitMinutes,
      appointmentsToday,
      capacityThreshold,
      overrideExpiresAt,
    };
  }

  const total = resources.length;
  const occupied = resources.filter((r) => r.status === "occupied").length;
  const occupancy = total > 0 ? occupied / total : 0;
  const thresholdReached =
    capacityThreshold != null && capacityThreshold > 0 && appointmentsToday >= capacityThreshold;
  const thresholdNear =
    capacityThreshold != null &&
    capacityThreshold > 0 &&
    appointmentsToday >= Math.ceil(capacityThreshold * 0.75);

  let status: CapacityStatus = "available";
  if (waitMinutes >= BUSY_WAIT_MINUTES || thresholdReached || (total > 0 && occupancy >= 1)) {
    status = "busy";
  } else if (waitMinutes >= MODERATE_WAIT_MINUTES || thresholdNear || occupancy >= 0.5) {
    status = "moderate";
  }
  return {
    status,
    source: "auto",
    waitMinutes,
    appointmentsToday,
    capacityThreshold,
    overrideExpiresAt: null,
  };
}

// ── Short-lived cache ────────────────────────────────────────────────────────
// Directory and public listing reads are frequent; the status only needs to
// be fresh within tens of seconds, so a tiny in-process TTL cache keeps those
// surfaces from hammering the DB. The surge engine always computes uncached.

const CACHE_TTL_MS = 30_000;
const cache = new Map<number, { at: number; result: CapacityStatusResult }>();

/** Test hook: clear the capacity-status cache. */
export function __clearCapacityStatusCache(): void {
  cache.clear();
}

export async function cachedCapacityStatus(
  tenantId: number,
  now: Date = new Date(),
): Promise<CapacityStatusResult> {
  const hit = cache.get(tenantId);
  if (hit && now.getTime() - hit.at < CACHE_TTL_MS) return hit.result;
  const result = await computeCapacityStatus(tenantId, now);
  cache.set(tenantId, { at: now.getTime(), result });
  // Opportunistic sweep so the map can't grow unboundedly.
  if (cache.size > 5_000) {
    for (const [k, v] of cache) {
      if (now.getTime() - v.at >= CACHE_TTL_MS) cache.delete(k);
    }
  }
  return result;
}

/** Batch cached statuses for a set of tenants (directory listings). */
export async function cachedCapacityStatusesFor(
  tenantIds: number[],
  now: Date = new Date(),
): Promise<Map<number, CapacityStatusResult>> {
  const out = new Map<number, CapacityStatusResult>();
  await Promise.all(
    tenantIds.map(async (id) => {
      out.set(id, await cachedCapacityStatus(id, now));
    }),
  );
  return out;
}
