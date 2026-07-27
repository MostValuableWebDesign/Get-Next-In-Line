import {
  db,
  clientProfilesTable,
  sosCustomersTable,
  sosVisitsTable,
} from "@workspace/db";
import { eq, inArray, isNotNull, and } from "drizzle-orm";
import { logger } from "./logger";

// ── Visit cadence computation ────────────────────────────────────────────────
// Computes each concierge client profile's last-visit timestamp and average
// days between completed visits from the real SOS visit history (via the
// sos_customers.client_profile_id link). The computed averageCycleDays feeds
// the rebooking-nudge automation; hand-set values (cycle_override = true) are
// never clobbered — only lastVisitAt is kept fresh for those profiles.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Minimum completed visits before a personal average cycle is computed. */
export const MIN_VISITS_FOR_CYCLE = 3;

export interface ComputedCadence {
  lastVisitAt: Date | null;
  /** Null when history is too thin (< MIN_VISITS_FOR_CYCLE completed visits). */
  averageCycleDays: number | null;
  completedVisits: number;
}

/**
 * Compute cadence from a list of completed-visit timestamps: last visit is
 * the max, average cycle is the mean gap between consecutive distinct visit
 * days (minimum 1 day), only when there are enough visits.
 */
export function computeCadenceFromDates(checkoutDates: Date[]): ComputedCadence {
  const sorted = [...checkoutDates].sort((a, b) => a.getTime() - b.getTime());
  const lastVisitAt = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  if (sorted.length < MIN_VISITS_FOR_CYCLE) {
    return { lastVisitAt, averageCycleDays: null, completedVisits: sorted.length };
  }
  const spanMs = sorted[sorted.length - 1].getTime() - sorted[0].getTime();
  const avgDays = Math.max(
    1,
    Math.round(spanMs / (sorted.length - 1) / MS_PER_DAY),
  );
  return { lastVisitAt, averageCycleDays: avgDays, completedVisits: sorted.length };
}

/** All completed-visit checkout timestamps for the customers linked to a profile. */
async function completedVisitDatesForProfile(clientProfileId: number): Promise<Date[]> {
  const customers = await db
    .select({ id: sosCustomersTable.id })
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.clientProfileId, clientProfileId));
  if (customers.length === 0) return [];
  const visits = await db
    .select({ checkedOutAt: sosVisitsTable.checkedOutAt })
    .from(sosVisitsTable)
    .where(
      and(
        inArray(
          sosVisitsTable.customerId,
          customers.map((c) => c.id),
        ),
        eq(sosVisitsTable.status, "checked_out"),
        isNotNull(sosVisitsTable.checkedOutAt),
      ),
    );
  return visits.map((v) => v.checkedOutAt!);
}

/**
 * Recompute and persist a profile's last-visit timestamp and (unless the
 * owner set a manual override) its average visit cycle from real history.
 * Never lets a computed pass clobber an overridden cycle, and never moves
 * lastVisitAt backwards past an existing (e.g. hand-set) newer value.
 */
export async function updateProfileCadence(
  clientProfileId: number | null,
): Promise<ComputedCadence | null> {
  if (clientProfileId == null) return null;
  const [profile] = await db
    .select()
    .from(clientProfilesTable)
    .where(eq(clientProfilesTable.id, clientProfileId));
  if (!profile) return null;

  const cadence = computeCadenceFromDates(
    await completedVisitDatesForProfile(clientProfileId),
  );

  const updates: Partial<typeof clientProfilesTable.$inferInsert> = {};
  if (
    cadence.lastVisitAt &&
    (!profile.lastVisitAt || cadence.lastVisitAt > profile.lastVisitAt)
  ) {
    updates.lastVisitAt = cadence.lastVisitAt;
  }
  if (!profile.cycleOverride && cadence.averageCycleDays != null) {
    updates.averageCycleDays = cadence.averageCycleDays;
  }
  if (Object.keys(updates).length > 0) {
    await db
      .update(clientProfilesTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(clientProfilesTable.id, clientProfileId));
  }
  return cadence;
}

/**
 * Idempotent one-time backfill: recompute cadence for every profile that has
 * at least one linked SOS customer. Safe to run repeatedly (e.g. at startup);
 * manual overrides are respected the same as on the live path.
 */
export async function backfillVisitCadence(): Promise<number> {
  const linked = await db
    .selectDistinct({ clientProfileId: sosCustomersTable.clientProfileId })
    .from(sosCustomersTable)
    .where(isNotNull(sosCustomersTable.clientProfileId));
  let updated = 0;
  for (const { clientProfileId } of linked) {
    const cadence = await updateProfileCadence(clientProfileId);
    if (cadence && cadence.completedVisits > 0) updated++;
  }
  if (updated > 0) {
    logger.info({ updated }, "Backfilled client-profile visit cadence from history");
  }
  return updated;
}
