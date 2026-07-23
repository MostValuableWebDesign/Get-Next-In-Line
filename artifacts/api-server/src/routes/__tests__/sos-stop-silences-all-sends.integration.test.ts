import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import twilio from "twilio";
import {
  db,
  sosCustomersTable,
  clientProfilesTable,
  messagesTable,
  tenantsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { sendMessage, type OutboundMessageKind } from "../../lib/messaging";

// ---------------------------------------------------------------------------
// End-to-end STOP compliance: an inbound STOP webhook must silence EVERY kind
// of outbound text the platform can send — manual sends, waitlist "you're
// next" / open-slot fills, AI receptionist follow-ups, and concierge
// reminders/rebooking nudges — on both the SOS customer record and the
// concierge client profile (including profiles matched only by phone).
// START must restore sends.
// ---------------------------------------------------------------------------

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME; // skip connector lookup
delete process.env.TWILIO_ACCOUNT_SID; // keep outbound in simulated mode
const AUTH_TOKEN = "test-auth-token-stop-e2e";
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;

const RUN = `stop-e2e-${Date.now()}-${process.pid}`;
const HOST = "sos-stop-e2e-test.local";
const PATH = "/api/sos/twilio/inbound";
const URL = `http://${HOST}${PATH}`;

// Unique per-run phone numbers (E.164, US)
const uniq = String(Date.now()).slice(-7);
const PHONE_CUSTOMER = `+1559${uniq}`; // SOS customer linked to a profile
const PHONE_PROFILE_ONLY = `+1560${uniq}`; // concierge profile only, no SOS customer

// Every outbound kind a person can receive (claim_confirmation is only sent
// in direct response to the person's own YES, so it's not in the STOP matrix).
const ALL_KINDS: OutboundMessageKind[] = [
  "manual",
  "you_are_next",
  "slot_open",
  "ai_followup",
  "send_reminder",
  "rebooking_nudge",
];

let app: import("express").Express;
let tenantId: number;
let customerId: number;
let linkedProfileId: number;
let phoneOnlyProfileId: number;

function signedPost(params: Record<string, string>) {
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, URL, params);
  return request(app)
    .post(PATH)
    .set("Host", HOST)
    .set("X-Twilio-Signature", signature)
    .type("form")
    .send(params);
}

/** Attempt one send of each kind and return the finalized message rows. */
async function sendAllKinds(target: {
  customerId?: number | null;
  clientProfileId?: number | null;
  toNumber: string;
}) {
  const rows = [];
  for (const kind of ALL_KINDS) {
    rows.push(
      await sendMessage({
        customerId: target.customerId ?? null,
        clientProfileId: target.clientProfileId ?? null,
        toNumber: target.toNumber,
        kind,
        body: `${kind} test message ${RUN}`,
      }),
    );
  }
  return rows;
}

beforeAll(async () => {
  app = (await import("../../app")).default;

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `StopE2E ${RUN}`, subdomain: RUN, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;

  // Case 1: an SOS customer linked to a concierge profile (same phone).
  const [profile] = await db
    .insert(clientProfilesTable)
    .values({ tenantId, name: `Linked ${RUN}`, phone: PHONE_CUSTOMER })
    .returning({ id: clientProfilesTable.id });
  linkedProfileId = profile.id;
  const [customer] = await db
    .insert(sosCustomersTable)
    .values({
      name: `Customer ${RUN}`,
      phone: PHONE_CUSTOMER,
      smsOptIn: true,
      clientProfileId: profile.id,
    })
    .returning({ id: sosCustomersTable.id });
  customerId = customer.id;

  // Case 2: a sender who exists ONLY as a concierge client profile —
  // matched purely by phone number on an inbound STOP.
  const [phoneOnly] = await db
    .insert(clientProfilesTable)
    .values({ tenantId, name: `PhoneOnly ${RUN}`, phone: PHONE_PROFILE_ONLY })
    .returning({ id: clientProfilesTable.id });
  phoneOnlyProfileId = phoneOnly.id;
});

afterAll(async () => {
  await db
    .delete(messagesTable)
    .where(inArray(messagesTable.toNumber, [PHONE_CUSTOMER, PHONE_PROFILE_ONLY]));
  await db.delete(sosCustomersTable).where(eq(sosCustomersTable.id, customerId));
  // Cascades client_profiles rows.
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

describe("STOP silences every outbound kind (SOS customer + linked profile)", () => {
  it("all kinds deliver before STOP", async () => {
    const rows = await sendAllKinds({ customerId, toNumber: PHONE_CUSTOMER });
    for (const row of rows) {
      expect(row.status, `${row.kind} should send pre-STOP`).toBe("simulated");
      expect(row.errorCode).toBeNull();
    }
  });

  it("a signed STOP opts out both the customer and the linked profile", async () => {
    const res = await signedPost({
      From: PHONE_CUSTOMER,
      Body: "STOP",
      MessageSid: `SMstop${uniq}a`,
    });
    expect(res.status).toBe(200);

    const [cust] = await db
      .select({ smsOptIn: sosCustomersTable.smsOptIn })
      .from(sosCustomersTable)
      .where(eq(sosCustomersTable.id, customerId));
    expect(cust.smsOptIn).toBe(false);
    const [prof] = await db
      .select({ smsOptIn: clientProfilesTable.smsOptIn })
      .from(clientProfilesTable)
      .where(eq(clientProfilesTable.id, linkedProfileId));
    expect(prof.smsOptIn).toBe(false);
  });

  it("every kind addressed to the customer is skipped as opted_out", async () => {
    const rows = await sendAllKinds({ customerId, toNumber: PHONE_CUSTOMER });
    for (const row of rows) {
      expect(row.status, `${row.kind} must be skipped after STOP`).toBe("skipped");
      expect(row.errorCode, `${row.kind} must record opted_out`).toBe("opted_out");
    }
  });

  it("every kind addressed to the linked profile is also skipped as opted_out", async () => {
    const rows = await sendAllKinds({
      clientProfileId: linkedProfileId,
      toNumber: PHONE_CUSTOMER,
    });
    for (const row of rows) {
      expect(row.status, `${row.kind} via profile must be skipped`).toBe("skipped");
      expect(row.errorCode).toBe("opted_out");
    }
  });

  it("START restores sends for every kind", async () => {
    const res = await signedPost({
      From: PHONE_CUSTOMER,
      Body: "START",
      MessageSid: `SMstart${uniq}a`,
    });
    expect(res.status).toBe(200);

    const [cust] = await db
      .select({ smsOptIn: sosCustomersTable.smsOptIn })
      .from(sosCustomersTable)
      .where(eq(sosCustomersTable.id, customerId));
    expect(cust.smsOptIn).toBe(true);

    const rows = await sendAllKinds({ customerId, toNumber: PHONE_CUSTOMER });
    for (const row of rows) {
      expect(row.status, `${row.kind} should send after START`).toBe("simulated");
      expect(row.errorCode).toBeNull();
    }
  });
});

describe("STOP from a phone-matched concierge profile (no SOS customer)", () => {
  it("STOP opts out the profile matched only by phone", async () => {
    const res = await signedPost({
      From: PHONE_PROFILE_ONLY,
      Body: " stop ",
      MessageSid: `SMstop${uniq}b`,
    });
    expect(res.status).toBe(200);

    const [prof] = await db
      .select({ smsOptIn: clientProfilesTable.smsOptIn })
      .from(clientProfilesTable)
      .where(eq(clientProfilesTable.id, phoneOnlyProfileId));
    expect(prof.smsOptIn).toBe(false);
  });

  it("every kind addressed to that profile is skipped as opted_out", async () => {
    const rows = await sendAllKinds({
      clientProfileId: phoneOnlyProfileId,
      toNumber: PHONE_PROFILE_ONLY,
    });
    for (const row of rows) {
      expect(row.status, `${row.kind} must be skipped after STOP`).toBe("skipped");
      expect(row.errorCode).toBe("opted_out");
    }
  });

  it("START re-enables sends to the profile", async () => {
    const res = await signedPost({
      From: PHONE_PROFILE_ONLY,
      Body: "START",
      MessageSid: `SMstart${uniq}b`,
    });
    expect(res.status).toBe(200);

    const rows = await sendAllKinds({
      clientProfileId: phoneOnlyProfileId,
      toNumber: PHONE_PROFILE_ONLY,
    });
    for (const row of rows) {
      expect(row.status, `${row.kind} should send after START`).toBe("simulated");
      expect(row.errorCode).toBeNull();
    }
  });
});
