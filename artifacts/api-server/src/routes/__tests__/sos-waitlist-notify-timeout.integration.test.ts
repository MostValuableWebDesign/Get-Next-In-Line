import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  sosCustomersTable,
  sosWaitlistTable,
  sosAppointmentsTable,
  tenantsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  claimWaitlistSlot,
  expireStaleNotifiedWaitlistEntries,
  waitlistNotifyTimeoutMs,
} from "../../lib/waitlistClaim";
import { runConciergeTick } from "../../workers/concierge";

// ---------------------------------------------------------------------------
// Waitlist notify-timeout: notified entries whose "Reply YES to claim" window
// lapsed must revert to "waiting" (background sweep + lazy check on claim),
// and a late claim must fail as "already_claimed" — never book a stale slot.
// ---------------------------------------------------------------------------

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const RUN = `wl-timeout-${Date.now()}-${process.pid}`;
const SERVICE = `Timeout Cut ${RUN}`; // unique per run: never matches other suites

let tenantId: number;
const customerIds: number[] = [];
const entryIds: number[] = [];

const uniq = String(Date.now()).slice(-7);

function minutesAgo(min: number) {
  return new Date(Date.now() - min * 60_000);
}

async function makeCustomer(name: string) {
  const [c] = await db
    .insert(sosCustomersTable)
    .values({ name: `${name} ${RUN}`, phone: `+1560${uniq}`, tenantId })
    .returning();
  customerIds.push(c.id);
  return c;
}

async function makeNotifiedEntry(customerId: number, notifiedAt: Date) {
  const [e] = await db
    .insert(sosWaitlistTable)
    .values({
      tenantId,
      customerId,
      desiredService: SERVICE,
      status: "notified",
      notifiedAt,
      openSlotStartsAt: new Date(Date.now() + 60 * 60_000),
      openSlotEndsAt: new Date(Date.now() + 90 * 60_000),
    })
    .returning();
  entryIds.push(e.id);
  return e;
}

async function reload(id: number) {
  const [row] = await db.select().from(sosWaitlistTable).where(eq(sosWaitlistTable.id, id));
  return row;
}

beforeAll(async () => {
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `WL Timeout ${RUN}`, subdomain: RUN, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;
});

afterAll(async () => {
  if (entryIds.length > 0) {
    await db.delete(sosWaitlistTable).where(inArray(sosWaitlistTable.id, entryIds));
  }
  if (customerIds.length > 0) {
    await db
      .delete(sosAppointmentsTable)
      .where(inArray(sosAppointmentsTable.customerId, customerIds));
    await db.delete(sosCustomersTable).where(inArray(sosCustomersTable.id, customerIds));
  }
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

describe("waitlist notify timeout", () => {
  it("defaults to 30 minutes and is configurable via env", () => {
    const prev = process.env.WAITLIST_NOTIFY_TIMEOUT_MINUTES;
    delete process.env.WAITLIST_NOTIFY_TIMEOUT_MINUTES;
    expect(waitlistNotifyTimeoutMs()).toBe(30 * 60_000);
    process.env.WAITLIST_NOTIFY_TIMEOUT_MINUTES = "45";
    expect(waitlistNotifyTimeoutMs()).toBe(45 * 60_000);
    process.env.WAITLIST_NOTIFY_TIMEOUT_MINUTES = "not-a-number";
    expect(waitlistNotifyTimeoutMs()).toBe(30 * 60_000);
    if (prev === undefined) delete process.env.WAITLIST_NOTIFY_TIMEOUT_MINUTES;
    else process.env.WAITLIST_NOTIFY_TIMEOUT_MINUTES = prev;
  });

  it("sweep reverts stale notified entries but leaves fresh ones alone", async () => {
    const cust = await makeCustomer("Stale Sweep");
    const stale = await makeNotifiedEntry(cust.id, minutesAgo(31));
    const fresh = await makeNotifiedEntry(cust.id, minutesAgo(5));

    const reverted = await expireStaleNotifiedWaitlistEntries();
    expect(reverted).toBeGreaterThanOrEqual(1);

    const staleAfter = await reload(stale.id);
    expect(staleAfter.status).toBe("waiting");
    expect(staleAfter.notifiedAt).toBeNull();
    expect(staleAfter.openSlotStartsAt).toBeNull();
    expect(staleAfter.openSlotEndsAt).toBeNull();

    const freshAfter = await reload(fresh.id);
    expect(freshAfter.status).toBe("notified");
    expect(freshAfter.openSlotStartsAt).not.toBeNull();
  });

  it("lazy check: claiming a stale notified entry fails as already_claimed and reverts it", async () => {
    const cust = await makeCustomer("Late Yes");
    const stale = await makeNotifiedEntry(cust.id, minutesAgo(45));

    // This is the path a late SMS "YES" takes (the inbound webhook calls
    // claimWaitlistSlot); "already_claimed" produces the existing "slot was
    // already claimed" reply instead of booking a stale slot.
    const result = await claimWaitlistSlot(stale.id, { tenantId });
    expect(result.outcome).toBe("already_claimed");

    const after = await reload(stale.id);
    expect(after.status).toBe("waiting");
    expect(after.notifiedAt).toBeNull();

    // No appointment was booked from the stale offer.
    const appts = await db
      .select()
      .from(sosAppointmentsTable)
      .where(
        and(
          eq(sosAppointmentsTable.customerId, cust.id),
          eq(sosAppointmentsTable.source, "waitlist_fill"),
        ),
      );
    expect(appts).toHaveLength(0);
  });

  it("a fresh notified entry still claims normally", async () => {
    const cust = await makeCustomer("Fresh Claim");
    const fresh = await makeNotifiedEntry(cust.id, minutesAgo(2));

    const result = await claimWaitlistSlot(fresh.id, { tenantId });
    expect(result.outcome).toBe("claimed");
    if (result.outcome === "claimed") {
      expect(result.appointment.source).toBe("waitlist_fill");
    }
    const after = await reload(fresh.id);
    expect(after.status).toBe("booked");
  });

  it("concierge tick runs the sweep", async () => {
    const cust = await makeCustomer("Tick Sweep");
    const stale = await makeNotifiedEntry(cust.id, minutesAgo(60));

    const tick = await runConciergeTick();
    // The advisory lock is uncontended in a serial test run.
    expect(tick.ran).toBe(true);
    expect(tick.staleWaitlistReverted).toBeGreaterThanOrEqual(1);
    expect((await reload(stale.id)).status).toBe("waiting");
  });
});
