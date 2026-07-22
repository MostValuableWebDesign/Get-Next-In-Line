import {
  db,
  sosWaitlistTable,
  sosCustomersTable,
  sosAppointmentsTable,
} from "@workspace/db";
import { and, eq, ne } from "drizzle-orm";
import { placeDepositHoldIfActive } from "./noShowShield";

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
export async function claimWaitlistSlot(entryId: number): Promise<ClaimResult> {
  const [found] = await db
    .select({ entry: sosWaitlistTable, customer: sosCustomersTable })
    .from(sosWaitlistTable)
    .innerJoin(sosCustomersTable, eq(sosWaitlistTable.customerId, sosCustomersTable.id))
    .where(eq(sosWaitlistTable.id, entryId));
  if (!found) return { outcome: "not_found" };

  const { entry, customer } = found;
  if (entry.status !== "notified" || !entry.openSlotStartsAt || !entry.openSlotEndsAt) {
    // "booked"/"waiting"/"expired" — a notified entry that lost the race has
    // already been reverted to "waiting", so this also covers late claims.
    return entry.status === "waiting" || entry.status === "booked"
      ? { outcome: "already_claimed" }
      : { outcome: "no_slot_held" };
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
      serviceType: entry.desiredService,
      startsAt: slotStart,
      endsAt: slotEnd,
      source: "waitlist_fill",
    })
    .returning();

  // No-Show Shield applies to waitlist-filled bookings too.
  const depositHold = await placeDepositHoldIfActive(appointment.id);

  // Everyone else who was notified for this same slot goes back to waiting.
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
        ne(sosWaitlistTable.id, entryId),
      ),
    );

  return { outcome: "claimed", appointment, customer, depositHold };
}
