import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import {
  db,
  sosCustomersTable,
  sosVisitsTable,
  sosResourcesTable,
  sosAppointmentsTable,
  sosWaitlistTable,
  sosCallsTable,
  sosSettingsTable,
  messagesTable,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Failure-resilience tests: with a Twilio client that always throws on send,
// the queue-advance "notify", waitlist open-slot broadcast, and AI
// receptionist flows must still update the customer's row — the failed SMS
// is recorded on the message, never silently stalling the flow.
// ---------------------------------------------------------------------------

vi.mock("twilio", () => {
  const throwingClient = () => ({
    messages: {
      create: vi.fn().mockRejectedValue(
        Object.assign(new Error("Twilio is down (mock)"), { code: 20500 }),
      ),
    },
  });
  const factory: any = throwingClient;
  factory.validateRequest = () => false;
  return { default: factory };
});

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL; // deterministic intent parser
delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
// Full live-mode creds so deliverSms actually attempts the (mocked) Twilio send.
process.env.TWILIO_ACCOUNT_SID = "ACtest_resilience";
process.env.TWILIO_AUTH_TOKEN = "test-token-resilience";
process.env.TWILIO_PHONE_NUMBER = "+15550000000";

const RUN = `resil-${Date.now()}-${process.pid}`;
const uniq = String(Date.now()).slice(-7);
const PHONE_A = `+1558${uniq}`;
const PHONE_B = `+1559${uniq}`;
const PHONE_CALLER = `+1560${uniq}`;

let agent: ReturnType<typeof request.agent>;
const customerIds: number[] = [];
let resourceId: number;
let savedSettings: { waitlistAutoFillEnabled: boolean; aiReceptionistEnabled: boolean } | null =
  null;

async function latestOutboundFor(customerId: number) {
  const [row] = await db
    .select()
    .from(messagesTable)
    .where(
      and(eq(messagesTable.direction, "outbound"), eq(messagesTable.customerId, customerId)),
    )
    .orderBy(desc(messagesTable.id))
    .limit(1);
  return row;
}

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  // Tenant-scoped routes now require explicit tenant context; these tests
  // exercise the legacy (NULL-tenant) scope unless a request overrides it.
  agent.set("x-tenant-id", "legacy");
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [s] = await db.select().from(sosSettingsTable).limit(1);
  if (s) {
    savedSettings = {
      waitlistAutoFillEnabled: s.waitlistAutoFillEnabled,
      aiReceptionistEnabled: s.aiReceptionistEnabled,
    };
  }
  await agent
    .patch("/api/sos/settings")
    .send({ waitlistAutoFillEnabled: true, aiReceptionistEnabled: true })
    .expect(200);

  const rows = await db
    .insert(sosCustomersTable)
    .values([
      { name: `Resil A ${RUN}`, phone: PHONE_A, smsOptIn: true },
      { name: `Resil B ${RUN}`, phone: PHONE_B, smsOptIn: true },
    ])
    .returning({ id: sosCustomersTable.id });
  customerIds.push(...rows.map((r) => r.id));

  const [resource] = await db
    .insert(sosResourcesTable)
    .values({ name: `Chair ${RUN}`, resourceType: "chair", status: "available" })
    .returning({ id: sosResourcesTable.id });
  resourceId = resource.id;
});

afterAll(async () => {
  if (savedSettings) {
    await agent.patch("/api/sos/settings").send(savedSettings);
  }
  // Simulate-call may create a customer for the caller number.
  const callerCustomers = await db
    .select({ id: sosCustomersTable.id })
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.phone, PHONE_CALLER));
  customerIds.push(...callerCustomers.map((c) => c.id));

  await db.delete(messagesTable).where(inArray(messagesTable.customerId, customerIds));
  await db.delete(sosCallsTable).where(eq(sosCallsTable.fromNumber, PHONE_CALLER));
  await db
    .delete(sosAppointmentsTable)
    .where(inArray(sosAppointmentsTable.customerId, customerIds));
  await db.delete(sosWaitlistTable).where(inArray(sosWaitlistTable.customerId, customerIds));
  await db.delete(sosVisitsTable).where(inArray(sosVisitsTable.customerId, customerIds));
  await db.delete(sosResourcesTable).where(eq(sosResourcesTable.id, resourceId));
  await db.delete(sosCustomersTable).where(inArray(sosCustomersTable.id, customerIds));
});

describe("queue advance 'notify' with Twilio down", () => {
  it("still moves the visit to notified and records the failed SMS", async () => {
    const checkIn = await agent
      .post("/api/sos/visits")
      .send({ customerId: customerIds[0], serviceType: `Cut ${RUN}` })
      .expect(201);
    const visitId = checkIn.body.id;

    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .send({ action: "assign", resourceId })
      .expect(200);

    const res = await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .send({ action: "notify" })
      .expect(200);
    expect(res.body.status).toBe("notified");

    const [visit] = await db
      .select()
      .from(sosVisitsTable)
      .where(eq(sosVisitsTable.id, visitId));
    expect(visit.status).toBe("notified");

    const msg = await latestOutboundFor(customerIds[0]);
    expect(msg.kind).toBe("you_are_next");
    expect(msg.status).toBe("failed");
    expect(msg.errorCode).toBe("20500");

    // The customer must not be stalled: staff can keep advancing the visit
    // through the rest of the queue even though the notify SMS failed.
    const started = await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .send({ action: "start_service" })
      .expect(200);
    expect(started.body.status).toBe("in_service");
  });
});

describe("waitlist open-slot broadcast with Twilio down", () => {
  it("still marks entries notified and records failed sends", async () => {
    const service = `Broadcast ${RUN}`;
    const start = new Date("2026-09-01T15:00:00.000Z");
    const end = new Date("2026-09-01T16:00:00.000Z");
    const appt = await agent
      .post("/api/sos/appointments")
      .send({
        customerId: customerIds[0],
        serviceType: service,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
      })
      .expect(201);
    // Two waiting entries: a failed send for the first must not abort the
    // broadcast loop before the second is notified.
    const inserted = await db
      .insert(sosWaitlistTable)
      .values([
        { customerId: customerIds[1], desiredService: service, status: "waiting" },
        { customerId: customerIds[0], desiredService: service, status: "waiting" },
      ])
      .returning({ id: sosWaitlistTable.id });
    const entryIds = inserted.map((r) => r.id);

    const res = await agent
      .post(`/api/sos/appointments/${appt.body.id}/cancel`)
      .expect(200);
    expect(res.body.waitlistNotified).toBe(2);

    const after = await db
      .select()
      .from(sosWaitlistTable)
      .where(inArray(sosWaitlistTable.id, entryIds));
    expect(after).toHaveLength(2);
    for (const row of after) {
      expect(row.status).toBe("notified");
      expect(row.openSlotStartsAt).not.toBeNull();
    }

    for (const cid of [customerIds[0], customerIds[1]]) {
      const msg = await latestOutboundFor(cid);
      expect(msg.kind).toBe("slot_open");
      expect(msg.status).toBe("failed");
    }
  });
});

describe("AI receptionist simulate-call with Twilio down", () => {
  it("still records the call and outcome; the follow-up SMS is failed", async () => {
    const res = await agent
      .post("/api/sos/calls")
      .send({
        fromNumber: PHONE_CALLER,
        callerName: `Caller ${RUN}`,
        inquiry: "I'd like to book an appointment for tomorrow at 2pm.",
      })
      .expect(201);
    expect(["booked", "followup_sms", "message_taken"]).toContain(res.body.outcome);

    const [call] = await db
      .select()
      .from(sosCallsTable)
      .where(eq(sosCallsTable.fromNumber, PHONE_CALLER))
      .orderBy(desc(sosCallsTable.id))
      .limit(1);
    expect(call).toBeDefined();

    if (res.body.outcome !== "message_taken") {
      const [caller] = await db
        .select({ id: sosCustomersTable.id })
        .from(sosCustomersTable)
        .where(eq(sosCustomersTable.phone, PHONE_CALLER));
      const msg = await latestOutboundFor(caller.id);
      expect(msg.kind).toBe("ai_followup");
      expect(msg.status).toBe("failed");
    }
  });
});
