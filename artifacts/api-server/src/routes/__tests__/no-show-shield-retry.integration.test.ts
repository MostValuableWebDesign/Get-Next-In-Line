import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// ── Stripe mock ──────────────────────────────────────────────────────────────
// Controllable failure injection: each queued failure is thrown (in order) by
// the next paymentIntents.capture / .cancel call; when the queue is empty the
// call succeeds and is recorded.
const stripeCalls = {
  captures: [] as Array<{ id: string; amount_to_capture: number }>,
  cancels: [] as string[],
};
const captureFailures: Array<Error & { type?: string }> = [];
const cancelFailures: Array<Error & { type?: string }> = [];

function stripeError(message: string, type?: string): Error & { type?: string } {
  const err = new Error(message) as Error & { type?: string };
  if (type) err.type = type;
  return err;
}

vi.mock("../../lib/stripeClient", () => ({
  isStripeConfigured: () => true,
  getUncachableStripeClient: async () => ({
    paymentIntents: {
      capture: async (id: string, opts: { amount_to_capture: number }) => {
        const failure = captureFailures.shift();
        if (failure) throw failure;
        stripeCalls.captures.push({ id, amount_to_capture: opts.amount_to_capture });
        return { id, status: "succeeded" };
      },
      cancel: async (id: string) => {
        const failure = cancelFailures.shift();
        if (failure) throw failure;
        stripeCalls.cancels.push(id);
        return { id, status: "canceled" };
      },
    },
    checkout: {
      sessions: {
        create: async () => {
          throw new Error("not used in these tests");
        },
        expire: async (id: string) => ({ id, status: "expired" }),
      },
    },
  }),
  getStripeSync: async () => {
    throw new Error("not used in tests");
  },
}));

import {
  db,
  sosCustomersTable,
  sosAppointmentsTable,
  sosDepositHoldsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  captureHoldForNoShow,
  settleHoldOnCancellation,
  sweepDepositHoldRetries,
  applyStripeDepositEvent,
  MAX_DEPOSIT_RETRY_ATTEMPTS,
} from "../../lib/noShowShield";

// ---------------------------------------------------------------------------
// Retry behavior for failed Stripe capture/void operations on deposit holds:
//  - transient failures schedule an automatic retry (attempts + next time)
//  - the worker sweep re-attempts and settles on success
//  - permanent declines go terminal immediately (no retry)
//  - the retry budget exhausts into a terminal, human-readable "failed" state
//  - concurrent sweeps can never double-capture, and a hold settled by
//    another path (e.g. a Stripe void webhook) is never captured afterwards
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `nss-retry-${Date.now()}-${process.pid}`;

let customerId: number;
const appointmentIds: number[] = [];

/** Insert an appointment + "held" deposit hold (real PaymentIntent) directly. */
async function createHeldHold(opts?: { startsAt?: Date }) {
  const startsAt = opts?.startsAt ?? new Date(Date.now() + 60 * 60 * 1000);
  const [appt] = await db
    .insert(sosAppointmentsTable)
    .values({
      customerId,
      serviceType: `svc-${RUN}`,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
      source: "staff",
    })
    .returning();
  appointmentIds.push(appt.id);
  const [hold] = await db
    .insert(sosDepositHoldsTable)
    .values({
      appointmentId: appt.id,
      depositAmount: "25.00",
      feeAmount: "15.00",
      cancellationWindowHours: 24,
      status: "held",
      stripePaymentIntentId: `pi_${RUN}_${appt.id}`,
    })
    .returning();
  return { appt, hold };
}

async function getHold(holdId: number) {
  const [hold] = await db
    .select()
    .from(sosDepositHoldsTable)
    .where(eq(sosDepositHoldsTable.id, holdId));
  return hold;
}

beforeAll(async () => {
  const [customer] = await db
    .insert(sosCustomersTable)
    .values({ name: `Customer ${RUN}`, phone: null, smsOptIn: false })
    .returning();
  customerId = customer.id;
});

afterAll(async () => {
  if (appointmentIds.length > 0) {
    await db
      .delete(sosAppointmentsTable)
      .where(inArray(sosAppointmentsTable.id, appointmentIds));
  }
  await db.delete(sosCustomersTable).where(eq(sosCustomersTable.id, customerId));
});

describe("transient failure → automatic retry", () => {
  it("schedules a retry on a transient no-show capture failure, then the sweep captures", async () => {
    const { appt, hold } = await createHeldHold();
    captureFailures.push(stripeError("Stripe API is down", "StripeAPIError"));

    const afterFailure = await captureHoldForNoShow(appt.id);
    expect(afterFailure?.status).toBe("held");
    expect(afterFailure?.retryOperation).toBe("capture_no_show");
    expect(afterFailure?.retryAttempts).toBe(1);
    expect(afterFailure?.nextRetryAt).toBeTruthy();
    expect(afterFailure?.outcomeReason).toContain("will retry automatically");

    // Not due yet: the sweep must not touch it.
    const early = await sweepDepositHoldRetries(new Date());
    expect(early).toBe(0);
    expect((await getHold(hold.id)).status).toBe("held");

    // Due: the sweep re-attempts and (Stripe healthy again) captures.
    const capturesBefore = stripeCalls.captures.length;
    const attempted = await sweepDepositHoldRetries(
      new Date(afterFailure!.nextRetryAt!.getTime() + 1000),
    );
    expect(attempted).toBe(1);
    const settled = await getHold(hold.id);
    expect(settled.status).toBe("captured");
    expect(settled.retryOperation).toBeNull();
    expect(settled.nextRetryAt).toBeNull();
    expect(settled.outcomeReason).toContain("no-show fee captured");
    expect(stripeCalls.captures.length).toBe(capturesBefore + 1);
    expect(stripeCalls.captures.at(-1)).toEqual({
      id: hold.stripePaymentIntentId,
      amount_to_capture: 1500,
    });
  });

  it("retries a transient void failure and releases the hold", async () => {
    const startsAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const { appt, hold } = await createHeldHold({ startsAt });
    cancelFailures.push(stripeError("connection reset", "StripeConnectionError"));

    // Cancelling well outside the 24h window → void, which fails transiently.
    const afterFailure = await settleHoldOnCancellation(appt.id, startsAt);
    expect(afterFailure?.status).toBe("held");
    expect(afterFailure?.retryOperation).toBe("void");
    expect(afterFailure?.retryAttempts).toBe(1);

    const attempted = await sweepDepositHoldRetries(
      new Date(afterFailure!.nextRetryAt!.getTime() + 1000),
    );
    expect(attempted).toBe(1);
    const settled = await getHold(hold.id);
    expect(settled.status).toBe("released");
    expect(settled.retryOperation).toBeNull();
    expect(stripeCalls.cancels).toContain(hold.stripePaymentIntentId);
  });
});

describe("permanent decline → no retry", () => {
  it("marks the hold terminally failed immediately on a card decline", async () => {
    const { appt, hold } = await createHeldHold();
    captureFailures.push(stripeError("Your card was declined.", "StripeCardError"));

    const result = await captureHoldForNoShow(appt.id);
    expect(result?.status).toBe("failed");
    expect(result?.retryOperation).toBeNull();
    expect(result?.nextRetryAt).toBeNull();
    expect(result?.outcomeReason).toContain("FAILED permanently");
    expect(result?.outcomeReason).toContain("Your card was declined.");

    // Nothing for the sweep to pick up, ever.
    const attempted = await sweepDepositHoldRetries(
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    );
    expect((await getHold(hold.id)).status).toBe("failed");
    expect(attempted).toBe(0);
  });

  it("goes terminal when a retry attempt hits a permanent decline", async () => {
    const { appt, hold } = await createHeldHold();
    captureFailures.push(stripeError("api glitch", "StripeAPIError"));
    const afterFailure = await captureHoldForNoShow(appt.id);
    expect(afterFailure?.retryOperation).toBe("capture_no_show");

    captureFailures.push(stripeError("card declined", "StripeCardError"));
    await sweepDepositHoldRetries(new Date(afterFailure!.nextRetryAt!.getTime() + 1000));
    const settled = await getHold(hold.id);
    expect(settled.status).toBe("failed");
    expect(settled.outcomeReason).toContain("FAILED permanently");
  });
});

describe("retry budget exhaustion", () => {
  it("flips to terminal failed with a clear reason after the budget is spent", async () => {
    const { appt, hold } = await createHeldHold();
    captureFailures.push(stripeError("outage", "StripeAPIError"));
    let current = await captureHoldForNoShow(appt.id);
    expect(current?.retryAttempts).toBe(1);

    // Keep failing every sweep until the budget is exhausted.
    for (let attempt = 2; attempt <= MAX_DEPOSIT_RETRY_ATTEMPTS; attempt++) {
      captureFailures.push(stripeError(`outage ${attempt}`, "StripeAPIError"));
      const attempted = await sweepDepositHoldRetries(
        new Date(current!.nextRetryAt!.getTime() + 1000),
      );
      expect(attempted).toBe(1);
      current = await getHold(hold.id);
      if (attempt < MAX_DEPOSIT_RETRY_ATTEMPTS) {
        expect(current!.status).toBe("held");
        expect(current!.retryAttempts).toBe(attempt);
      }
    }
    expect(current!.status).toBe("failed");
    expect(current!.retryOperation).toBeNull();
    expect(current!.outcomeReason).toContain("retry budget is exhausted");
    expect(current!.outcomeReason).toContain(`${MAX_DEPOSIT_RETRY_ATTEMPTS} times`);
    expect(current!.outcomeReason).toContain("needs staff attention");
  });
});

describe("idempotency", () => {
  it("never double-captures under concurrent sweeps", async () => {
    const { appt, hold } = await createHeldHold();
    captureFailures.push(stripeError("blip", "StripeAPIError"));
    const afterFailure = await captureHoldForNoShow(appt.id);

    const due = new Date(afterFailure!.nextRetryAt!.getTime() + 1000);
    const capturesBefore = stripeCalls.captures.length;
    const results = await Promise.all([
      sweepDepositHoldRetries(due),
      sweepDepositHoldRetries(due),
      sweepDepositHoldRetries(due),
    ]);
    // Exactly one sweep wins the claim and performs exactly one capture.
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(stripeCalls.captures.length).toBe(capturesBefore + 1);
    expect((await getHold(hold.id)).status).toBe("captured");
  });

  it("never captures a hold that was voided (released) before the retry ran", async () => {
    const { appt, hold } = await createHeldHold();
    captureFailures.push(stripeError("blip", "StripeAPIError"));
    const afterFailure = await captureHoldForNoShow(appt.id);
    expect(afterFailure?.retryOperation).toBe("capture_no_show");

    // The authorization is voided on Stripe's side before the retry fires
    // (e.g. the 7-day auto-expiry) → webhook flips the hold to released.
    await applyStripeDepositEvent({
      type: "payment_intent.canceled",
      data: { object: { id: hold.stripePaymentIntentId! } },
    });
    expect((await getHold(hold.id)).status).toBe("released");

    const capturesBefore = stripeCalls.captures.length;
    const attempted = await sweepDepositHoldRetries(
      new Date(afterFailure!.nextRetryAt!.getTime() + 1000),
    );
    expect(attempted).toBe(0);
    expect(stripeCalls.captures.length).toBe(capturesBefore);
    const final = await getHold(hold.id);
    expect(final.status).toBe("released");
    // The settle cleared the retry bookkeeping.
    expect(final.retryOperation).toBeNull();
    expect(final.nextRetryAt).toBeNull();
  });
});
