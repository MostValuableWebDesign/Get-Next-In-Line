import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import twilio from "twilio";
import {
  db,
  sosCustomersTable,
  sosWaitlistTable,
  sosMessagesTable,
  sosAppointmentsTable,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { claimWaitlistSlot } from "../../lib/waitlistClaim";

// ---------------------------------------------------------------------------
// Integration tests for the Twilio inbound-SMS webhook against the real dev
// database. Signature validation uses a test auth token: only
// TWILIO_AUTH_TOKEN is set (no ACCOUNT_SID), so outbound sends stay
// "simulated" while the webhook can verify real Twilio signatures.
// ---------------------------------------------------------------------------

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME; // skip connector lookup
delete process.env.TWILIO_ACCOUNT_SID; // keep outbound in simulated mode
const AUTH_TOKEN = "test-auth-token-abc123";
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;

const RUN = `inbound-${Date.now()}-${process.pid}`;
const HOST = "sos-inbound-test.local";
const PATH = "/api/sos/twilio/inbound";
const URL = `http://${HOST}${PATH}`;

let app: import("express").Express;
const customerIds: number[] = [];

// Unique per-run phone numbers (E.164, US)
const uniq = String(Date.now()).slice(-7);
const PHONE_A = `+1555${uniq}`;
const PHONE_B = `+1556${uniq}`;
const PHONE_UNKNOWN = `+1557${uniq}`;

let custA: { id: number };
let custB: { id: number };

function signedPost(params: Record<string, string>) {
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, URL, params);
  return request(app)
    .post(PATH)
    .set("Host", HOST)
    .set("X-Twilio-Signature", signature)
    .type("form")
    .send(params);
}

async function latestInbound(from: string) {
  const [row] = await db
    .select()
    .from(sosMessagesTable)
    .where(and(eq(sosMessagesTable.direction, "inbound"), eq(sosMessagesTable.toNumber, from)))
    .orderBy(desc(sosMessagesTable.id))
    .limit(1);
  return row;
}

async function latestOutboundFor(customerId: number) {
  const [row] = await db
    .select()
    .from(sosMessagesTable)
    .where(
      and(eq(sosMessagesTable.direction, "outbound"), eq(sosMessagesTable.customerId, customerId)),
    )
    .orderBy(desc(sosMessagesTable.id))
    .limit(1);
  return row;
}

beforeAll(async () => {
  app = (await import("../../app")).default;
  const [a, b] = await db
    .insert(sosCustomersTable)
    .values([
      // Stored with formatting to prove normalized matching works.
      { name: `Alice ${RUN}`, phone: `(555) ${uniq.slice(0, 3)}-${uniq.slice(3)}` },
      { name: `Bob ${RUN}`, phone: PHONE_B },
    ])
    .returning({ id: sosCustomersTable.id });
  custA = a;
  custB = b;
  customerIds.push(a.id, b.id);
});

afterAll(async () => {
  await db.delete(sosMessagesTable).where(inArray(sosMessagesTable.customerId, customerIds));
  await db
    .delete(sosMessagesTable)
    .where(inArray(sosMessagesTable.toNumber, [PHONE_A, PHONE_B, PHONE_UNKNOWN]));
  await db.delete(sosAppointmentsTable).where(inArray(sosAppointmentsTable.customerId, customerIds));
  await db.delete(sosWaitlistTable).where(inArray(sosWaitlistTable.customerId, customerIds));
  await db.delete(sosCustomersTable).where(inArray(sosCustomersTable.id, customerIds));
});

describe("POST /api/sos/twilio/inbound — signature validation", () => {
  it("rejects a request with an invalid signature and logs nothing", async () => {
    const res = await request(app)
      .post(PATH)
      .set("Host", HOST)
      .set("X-Twilio-Signature", "bogus-signature")
      .type("form")
      .send({ From: PHONE_UNKNOWN, Body: "YES" });
    expect(res.status).toBe(403);
    expect(await latestInbound(PHONE_UNKNOWN)).toBeUndefined();
  });

  it("rejects a request with no signature header", async () => {
    const res = await request(app)
      .post(PATH)
      .set("Host", HOST)
      .type("form")
      .send({ From: PHONE_UNKNOWN, Body: "YES" });
    expect(res.status).toBe(403);
  });

  it("accepts a correctly signed request", async () => {
    const res = await signedPost({ From: PHONE_UNKNOWN, Body: "hello there" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("xml");
  });
});

describe("inbound logging and customer matching", () => {
  it("logs unknown senders with no customer and sends no auto-response", async () => {
    const before = await db
      .select()
      .from(sosMessagesTable)
      .where(eq(sosMessagesTable.direction, "outbound"));
    const res = await signedPost({ From: PHONE_UNKNOWN, Body: "YES", MessageSid: "SMunknown1" });
    expect(res.status).toBe(200);
    const row = await latestInbound(PHONE_UNKNOWN);
    expect(row).toBeDefined();
    expect(row.customerId).toBeNull();
    expect(row.deliveryStatus).toBe("received");
    const after = await db
      .select()
      .from(sosMessagesTable)
      .where(eq(sosMessagesTable.direction, "outbound"));
    expect(after.length).toBe(before.length);
  });

  it("matches a customer whose stored phone is formatted differently", async () => {
    const res = await signedPost({ From: PHONE_A, Body: "just saying hi" });
    expect(res.status).toBe(200);
    const row = await latestInbound(PHONE_A);
    expect(row.customerId).toBe(custA.id);
    expect(row.kind).toBe("inbound");
  });
});

describe("STOP / START opt-out keywords", () => {
  it("STOP turns off smsOptIn; START turns it back on", async () => {
    await signedPost({ From: PHONE_B, Body: " Stop " });
    let [bob] = await db.select().from(sosCustomersTable).where(eq(sosCustomersTable.id, custB.id));
    expect(bob.smsOptIn).toBe(false);

    await signedPost({ From: PHONE_B, Body: "UNSUBSCRIBE" });
    [bob] = await db.select().from(sosCustomersTable).where(eq(sosCustomersTable.id, custB.id));
    expect(bob.smsOptIn).toBe(false);

    await signedPost({ From: PHONE_B, Body: "START" });
    [bob] = await db.select().from(sosCustomersTable).where(eq(sosCustomersTable.id, custB.id));
    expect(bob.smsOptIn).toBe(true);
  });
});

describe("reply-to-claim", () => {
  const slotStart = new Date("2026-08-01T15:00:00.000Z");
  const slotEnd = new Date("2026-08-01T16:00:00.000Z");
  let entryA: { id: number };
  let entryB: { id: number };

  beforeAll(async () => {
    const now = new Date();
    const rows = await db
      .insert(sosWaitlistTable)
      .values([
        {
          customerId: custA.id,
          desiredService: `Cut ${RUN}`,
          status: "notified",
          notifiedAt: now,
          openSlotStartsAt: slotStart,
          openSlotEndsAt: slotEnd,
        },
        {
          customerId: custB.id,
          desiredService: `Cut ${RUN}`,
          status: "notified",
          notifiedAt: now,
          openSlotStartsAt: slotStart,
          openSlotEndsAt: slotEnd,
        },
      ])
      .returning({ id: sosWaitlistTable.id });
    entryA = rows[0];
    entryB = rows[1];
  });

  it("first YES wins: books the slot, confirms by text, reverts other notified entries", async () => {
    const res = await signedPost({ From: PHONE_A, Body: "YES!" });
    expect(res.status).toBe(200);

    const [a] = await db.select().from(sosWaitlistTable).where(eq(sosWaitlistTable.id, entryA.id));
    expect(a.status).toBe("booked");

    const [appt] = await db
      .select()
      .from(sosAppointmentsTable)
      .where(eq(sosAppointmentsTable.customerId, custA.id));
    expect(appt).toBeDefined();
    expect(appt.source).toBe("waitlist_fill");
    expect(appt.startsAt.getTime()).toBe(slotStart.getTime());

    const confirm = await latestOutboundFor(custA.id);
    expect(confirm.kind).toBe("claim_confirmation");
    expect(confirm.body).toContain("booked");

    // Bob was notified for the same slot — he's back to waiting.
    const [b] = await db.select().from(sosWaitlistTable).where(eq(sosWaitlistTable.id, entryB.id));
    expect(b.status).toBe("waiting");
    expect(b.openSlotStartsAt).toBeNull();
  });

  it("a late YES from the loser gets a 'slot was claimed' text and stays waiting", async () => {
    const res = await signedPost({ From: PHONE_B, Body: "yes" });
    expect(res.status).toBe(200);

    const sorry = await latestOutboundFor(custB.id);
    expect(sorry.kind).toBe("claim_confirmation");
    expect(sorry.body.toLowerCase()).toContain("claimed");

    const [b] = await db.select().from(sosWaitlistTable).where(eq(sosWaitlistTable.id, entryB.id));
    expect(b.status).toBe("waiting");
    // No appointment for Bob.
    const appts = await db
      .select()
      .from(sosAppointmentsTable)
      .where(eq(sosAppointmentsTable.customerId, custB.id));
    expect(appts).toHaveLength(0);
  });

  it("claim race on the same entry: exactly one winner", async () => {
    const [entry] = await db
      .insert(sosWaitlistTable)
      .values({
        customerId: custB.id,
        desiredService: `Race ${RUN}`,
        status: "notified",
        notifiedAt: new Date(),
        openSlotStartsAt: new Date("2026-08-02T15:00:00.000Z"),
        openSlotEndsAt: new Date("2026-08-02T16:00:00.000Z"),
      })
      .returning({ id: sosWaitlistTable.id });

    const [r1, r2] = await Promise.all([
      claimWaitlistSlot(entry.id),
      claimWaitlistSlot(entry.id),
    ]);
    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toEqual(["already_claimed", "claimed"]);
  });
});
