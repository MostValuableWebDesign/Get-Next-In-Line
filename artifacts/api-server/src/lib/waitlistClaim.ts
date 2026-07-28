import {
  db,
  sosWaitlistTable,
  sosCustomersTable,
  sosAppointmentsTable,
} from "@workspace/db";
import { and, eq, isNotNull, isNull, lte, ne } from "drizzle-orm";
import { placeDepositHoldIfActive } from "./noShowShield";

// ── notified-entry timeout ───────────────────────────────────────────────────

/**
 * How long a "Reply YES to claim" offer stays open. After this window a
 * notified entry reverts to "waiting" so the queue can't silently stall on a
 * customer who never replies. Configurable via the
 * WAITLIST_NOTIFY_TIMEOUT_MINUTES env var (read per call so tests and
 * operators can tune it without a restart); defaults to 30 minutes.
 */
const DEFAULT_NOTIFY_TIMEOUT_MINUTES = 30;

export function waitlistNotifyTimeoutMs(): number {
  const raw = Number(process.env.WAITLIST_NOTIFY_TIMEOUT_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NOTIFY_TIMEOUT_MINUTES;
  return minutes * 60_000;
}

/**
 * Background sweep: revert every notified entry whose offer window has
 * lapsed back to "waiting" (clearing the held slot), across all tenant
 * scopes. Safe to run on every tick — the status guard makes it idempotent
 * and it can never race a successful claim (a claim flips status to
 * "booked" first). Returns the number of entries reverted.
 */
export async function expireStaleNotifiedWaitlistEntries(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - waitlistNotifyTimeoutMs());
  const reverted = await db
    .update(sosWaitlistTable)
    .set({
      status: "waiting",
      notifiedAt: null,
      openSlotStartsAt: null,
      openSlotEndsAt: null,
    })
    .where(
      and(
        eq(sosWaitlistTable.status, "notified"),
        isNotNull(sosWaitlistTable.notifiedAt),
        lte(sosWaitlistTable.notifiedAt, cutoff),
      ),
    )
    .returning({ id: sosWaitlistTable.id });
  return reverted.length;
}

type AppointmentRow = typeof sosAppointmentsTable.$inferSelect;
type CustomerRow = typeof sosCustomersTable.$inferSelect;

export type ClaimResult =
  | { outcome: "not_found" }
  | { outcome: "no_slot_held" }
  | { outcome: "already_claimed" }
  | {
      outcome: "claimed";
      appointment: AppointmentRow;
      customer: CustomerRow;
      depositHold: Awaited<ReturnType<typeof placeDepositHoldIfActive>>;
    };

/**
 * Atomically claim an open slot held by a notified waitlist entry.
 * First come, first served: the UPDATE only wins while the entry is still
 * "notified", so concurrent claims (UI button vs. SMS "YES" reply) can never
 * both book the slot. Shared by the UI claim endpoint and the Twilio
 * inbound-SMS webhook.
 */
export async function claimWaitlistSlot(
  entryId: number,
  scope?: { tenantId: number | null },
): Promise<ClaimResult> {
  const [found] = await db
    .select({ entry: sosWaitlistTable, customer: sosCustomersTable })
    .from(sosWaitlistTable)
    .innerJoin(sosCustomersTable, eq(sosWaitlistTable.customerId, sosCustomersTable.id))
    .where(
      and(
        eq(sosWaitlistTable.id, entryId),
        // Strict tenant scoping when a scope is given: tenant context claims
        // only that tenant's entries; no context claims only legacy entries.
        scope === undefined
          ? undefined
          : scope.tenantId == null
            ? isNull(sosWaitlistTable.tenantId)
            : eq(sosWaitlistTable.tenantId, scope.tenantId),
      ),
    );
  if (!found) return { outcome: "not_found" };

  const { entry, customer } = found;
  if (entry.status !== "notified" || !entry.openSlotStartsAt || !entry.openSlotEndsAt) {
    // "booked"/"waiting"/"expired" — a notified entry that lost the race has
    // already been reverted to "waiting", so this also covers late claims.
    return entry.status === "waiting" || entry.status === "booked"
      ? { outcome: "already_claimed" }
      : { outcome: "no_slot_held" };
  }
  // Lazy expiry: a notified offer older than the timeout window is stale —
  // revert it to "waiting" instead of booking a slot the business has likely
  // re-filled by now. The conditional update mirrors the claim's own race
  // guard, so a concurrent successful claim can't be undone here.
  if (
    entry.notifiedAt != null &&
    entry.notifiedAt.getTime() <= Date.now() - waitlistNotifyTimeoutMs()
  ) {
    await db
      .update(sosWaitlistTable)
      .set({
        status: "waiting",
        notifiedAt: null,
        openSlotStartsAt: null,
        openSlotEndsAt: null,
      })
      .where(
        and(eq(sosWaitlistTable.id, entryId), eq(sosWaitlistTable.status, "notified")),
      );
    // Same outcome a late "YES" would see after the sweep: the slot is gone,
    // the customer stays on the waitlist.
    return { outcome: "already_claimed" };
  }

  const slotStart = entry.openSlotStartsAt;
  const slotEnd = entry.openSlotEndsAt;

  // Atomic claim: only wins if the entry is still notified.
  const [won] = await db
    .update(sosWaitlistTable)
    .set({ status: "booked" })
    .where(and(eq(sosWaitlistTable.id, entryId), eq(sosWaitlistTable.status, "notified")))
    .returning({ id: sosWaitlistTable.id });
  if (!won) return { outcome: "already_claimed" };

  const [appointment] = await db
    .insert(sosAppointmentsTable)
    .values({
      customerId: entry.customerId,
      // The booking inherits the waitlist entry's tenant scope.
      tenantId: entry.tenantId,
      serviceType: entry.desiredService,
      startsAt: slotStart,
      endsAt: slotEnd,
      source: "waitlist_fill",
    })
    .returning();

  // No-Show Shield applies to waitlist-filled bookings too.
  const depositHold = await placeDepositHoldIfActive(appointment.id);

  // Everyone else who was notified for this same slot goes back to waiting —
  // within the same tenant scope only, so a claim can never reset another
  // tenant's notified entries that happen to share a slot timestamp.
  await db
    .update(sosWaitlistTable)
    .set({
      status: "waiting",
      notifiedAt: null,
      openSlotStartsAt: null,
      openSlotEndsAt: null,
    })
    .where(
      and(
        eq(sosWaitlistTable.status, "notified"),
        eq(sosWaitlistTable.openSlotStartsAt, slotStart),
        entry.tenantId == null
          ? isNull(sosWaitlistTable.tenantId)
          : eq(sosWaitlistTable.tenantId, entry.tenantId),
        ne(sosWaitlistTable.id, entryId),
      ),
    );

  return { outcome: "claimed", appointment, customer, depositHold };
}
