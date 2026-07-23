import {
  db,
  modulesTable,
  tenantModulesTable,
  sosDepositHoldsTable,
  sosAppointmentsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { getLegacySettings, resolveSettings, type SosSettingsRow } from "./settings";
import { logger } from "./logger";

export const NO_SHOW_SHIELD_SLUG = "no_show_shield";

export type DepositHoldRow = typeof sosDepositHoldsTable.$inferSelect;

/**
 * Whether the No-Show Shield module has been provisioned for the given
 * tenant scope. Under tenant context only that tenant's subscription counts;
 * for the legacy (NULL-tenant) scope, any subscription counts — that record
 * pre-dates per-tenant provisioning.
 */
export async function isNoShowShieldProvisioned(
  tenantId?: number | null,
): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tenantModulesTable)
    .innerJoin(modulesTable, eq(tenantModulesTable.moduleId, modulesTable.id))
    .where(
      and(
        eq(modulesTable.slug, NO_SHOW_SHIELD_SLUG),
        tenantId == null ? undefined : eq(tenantModulesTable.tenantId, tenantId),
      ),
    );
  return (row?.n ?? 0) > 0;
}

/** The policy is active only when the module is provisioned AND enabled. */
export async function isNoShowShieldActive(
  settings?: SosSettingsRow,
): Promise<boolean> {
  const s = settings ?? (await getLegacySettings());
  if (!s.noShowShieldEnabled) return false;
  return isNoShowShieldProvisioned(s.tenantId);
}

/**
 * Record the policy agreement and place a simulated card-on-file deposit
 * hold for a newly booked appointment. Terms are snapshotted from the
 * settings in force at booking time. No-op when the policy is inactive.
 *
 * Never throws: a hold failure must not abort the booking itself.
 */
export async function placeDepositHoldIfActive(
  appointmentId: number,
): Promise<DepositHoldRow | null> {
  try {
    // Policy terms come from the settings of the tenant that owns the
    // appointment (legacy global record for NULL-tenant bookings).
    const [appt] = await db
      .select({ tenantId: sosAppointmentsTable.tenantId })
      .from(sosAppointmentsTable)
      .where(eq(sosAppointmentsTable.id, appointmentId));
    const settings = await resolveSettings(appt?.tenantId ?? null);
    if (!(await isNoShowShieldActive(settings))) return null;
    const [hold] = await db
      .insert(sosDepositHoldsTable)
      .values({
        appointmentId,
        depositAmount: settings.noShowDepositAmount,
        feeAmount: settings.noShowFee,
        cancellationWindowHours: settings.noShowCancellationWindowHours,
        status: "held",
        outcomeReason: `Deposit held at booking under the No-Show Shield policy (cancel ≥${settings.noShowCancellationWindowHours}h before start for a full release).`,
      })
      .onConflictDoNothing()
      .returning();
    return hold ?? null;
  } catch (err) {
    logger.error({ err, appointmentId }, "Failed to place No-Show Shield deposit hold");
    return null;
  }
}

/**
 * Settle the hold when an appointment is cancelled: cancelling outside the
 * agreed window releases the hold; cancelling inside it captures the fee.
 * Uses the terms snapshotted on the hold, not current settings.
 * Conditional update: only settles a hold still in "held".
 */
export async function settleHoldOnCancellation(
  appointmentId: number,
  startsAt: Date,
  now: Date = new Date(),
): Promise<DepositHoldRow | null> {
  const [hold] = await db
    .select()
    .from(sosDepositHoldsTable)
    .where(eq(sosDepositHoldsTable.appointmentId, appointmentId));
  if (!hold || hold.status !== "held") return hold ?? null;

  const cutoff = new Date(
    startsAt.getTime() - hold.cancellationWindowHours * 60 * 60 * 1000,
  );
  const outsideWindow = now <= cutoff;
  const [settled] = await db
    .update(sosDepositHoldsTable)
    .set(
      outsideWindow
        ? {
            status: "released",
            resolvedAt: now,
            outcomeReason: `Cancelled more than ${hold.cancellationWindowHours}h before the start time — deposit hold released, no fee charged.`,
          }
        : {
            status: "captured",
            resolvedAt: now,
            outcomeReason: `Cancelled within the ${hold.cancellationWindowHours}h cancellation window — late-cancellation fee of $${hold.feeAmount} captured from the held deposit.`,
          },
    )
    .where(
      and(
        eq(sosDepositHoldsTable.id, hold.id),
        eq(sosDepositHoldsTable.status, "held"),
      ),
    )
    .returning();
  return settled ?? hold;
}

/** Capture the held deposit as a no-show penalty fee. */
export async function captureHoldForNoShow(
  appointmentId: number,
  now: Date = new Date(),
): Promise<DepositHoldRow | null> {
  const [hold] = await db
    .select()
    .from(sosDepositHoldsTable)
    .where(eq(sosDepositHoldsTable.appointmentId, appointmentId));
  if (!hold || hold.status !== "held") return hold ?? null;
  const [captured] = await db
    .update(sosDepositHoldsTable)
    .set({
      status: "captured",
      resolvedAt: now,
      outcomeReason: `Marked as a no-show — $${hold.feeAmount} no-show fee captured from the held deposit.`,
    })
    .where(
      and(
        eq(sosDepositHoldsTable.id, hold.id),
        eq(sosDepositHoldsTable.status, "held"),
      ),
    )
    .returning();
  return captured ?? hold;
}

/** Serialize a hold row into the SosDepositHold API shape (or null). */
export function serializeDepositHold(hold: DepositHoldRow | null | undefined) {
  if (!hold) return null;
  return {
    id: hold.id,
    status: hold.status,
    depositAmount: parseFloat(hold.depositAmount),
    feeAmount: parseFloat(hold.feeAmount),
    cancellationWindowHours: hold.cancellationWindowHours,
    outcomeReason: hold.outcomeReason,
    createdAt: hold.createdAt.toISOString(),
    resolvedAt: hold.resolvedAt ? hold.resolvedAt.toISOString() : null,
  };
}
