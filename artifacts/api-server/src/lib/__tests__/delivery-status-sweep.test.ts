import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { db, messagesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Delivery-status reconciliation sweep: outbound SMS rows stuck at "sent"
// are checked against Twilio's authoritative Messages API (mocked here) and
// flipped to delivered/failed through applyDeliveryStatus. This is the
// reliability net for connector-proxy mode, where StatusCallback signatures
// can't be verified.
// ---------------------------------------------------------------------------

const fetchTwilioMessageStatus = vi.fn();

vi.mock("../sms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sms")>();
  return {
    ...actual,
    fetchTwilioMessageStatus: (...args: unknown[]) =>
      fetchTwilioMessageStatus(...args),
  };
});

const { reconcileDeliveryStatuses, verifyDeliveryStatusBySid } = await import(
  "../deliveryStatusSweep"
);

const RUN = `${Date.now()}${process.pid}`.slice(-14);
// Real-looking Twilio SIDs (SM + 32 hex chars), unique per run.
const sid = (tag: string) =>
  `SM${tag}${RUN}`.padEnd(34, "0").slice(0, 34).toLowerCase().replace(/[^a-z0-9]/g, "0");
const SIDS = {
  delivered: sid("aa"),
  failed: sid("bb"),
  interim: sid("cc"),
  simulated: `simulated-${RUN}`,
};

const STALE = new Date(Date.now() - 10 * 60 * 1000);

async function insertSentMessage(providerSid: string) {
  const [row] = await db
    .insert(messagesTable)
    .values({
      direction: "outbound",
      kind: "manual",
      channel: "sms",
      toNumber: "+15550008888",
      body: `sweep test ${providerSid}`,
      status: "sent",
      providerSid,
      createdAt: STALE,
      updatedAt: STALE,
    })
    .returning();
  return row;
}

async function statusOf(providerSid: string) {
  const [row] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.providerSid, providerSid));
  return row;
}

beforeAll(async () => {
  for (const s of Object.values(SIDS)) await insertSentMessage(s);
});

afterAll(async () => {
  await db
    .delete(messagesTable)
    .where(inArray(messagesTable.providerSid, Object.values(SIDS)));
});

beforeEach(() => {
  fetchTwilioMessageStatus.mockReset();
});

describe("reconcileDeliveryStatuses", () => {
  it("flips stuck rows to delivered/failed from Twilio's authoritative status and skips non-Twilio SIDs", async () => {
    fetchTwilioMessageStatus.mockImplementation(async (providerSid: string) => {
      if (providerSid === SIDS.delivered) {
        return { messageStatus: "delivered", errorCode: null, errorMessage: null };
      }
      if (providerSid === SIDS.failed) {
        return { messageStatus: "undelivered", errorCode: "30034", errorMessage: "A2P" };
      }
      if (providerSid === SIDS.interim) {
        return { messageStatus: "sending", errorCode: null, errorMessage: null };
      }
      // Simulated / non-Twilio SIDs: the real fetch returns null for these.
      return null;
    });

    const finalized = await reconcileDeliveryStatuses();
    expect(finalized).toBeGreaterThanOrEqual(2);

    const delivered = await statusOf(SIDS.delivered);
    expect(delivered.status).toBe("delivered");

    const failed = await statusOf(SIDS.failed);
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("30034");

    // Interim Twilio status → row stays "sent" (never regresses/never finalizes early).
    expect((await statusOf(SIDS.interim)).status).toBe("sent");
    // Simulated marker stays untouched.
    expect((await statusOf(SIDS.simulated)).status).toBe("sent");
  });

  it("throttles: a freshly-updated row is not re-polled", async () => {
    fetchTwilioMessageStatus.mockResolvedValue({
      messageStatus: "sending",
      errorCode: null,
      errorMessage: null,
    });
    await db
      .update(messagesTable)
      .set({ status: "sent", updatedAt: new Date() })
      .where(eq(messagesTable.providerSid, SIDS.interim));
    await reconcileDeliveryStatuses();
    expect(
      fetchTwilioMessageStatus.mock.calls.map((c) => c[0]),
    ).not.toContain(SIDS.interim);
  });
});

describe("verifyDeliveryStatusBySid", () => {
  it("applies Twilio's authoritative status for one SID and never throws", async () => {
    await db
      .update(messagesTable)
      .set({ status: "sent", updatedAt: STALE })
      .where(eq(messagesTable.providerSid, SIDS.delivered));
    fetchTwilioMessageStatus.mockResolvedValue({
      messageStatus: "delivered",
      errorCode: null,
      errorMessage: null,
    });
    await verifyDeliveryStatusBySid(SIDS.delivered);
    expect((await statusOf(SIDS.delivered)).status).toBe("delivered");

    fetchTwilioMessageStatus.mockRejectedValue(new Error("boom"));
    await expect(verifyDeliveryStatusBySid(SIDS.failed)).resolves.toBeUndefined();
  });
});
