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
const PHONE_MULTI_TENANT = `+1561${uniq}`; // profiles in TWO tenants + ambiguous SOS customers

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
let tenantBId: number;
let customerId: number;
let linkedProfileId: number;
let phoneOnlyProfileId: number;
let multiProfileAId: number;
let multiProfileBId: number;
let multiCustomerAId: number;
let multiCustomerBId: number;

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

  // Case 3: one phone number matching concierge profiles in TWO different
  // tenants, plus SOS customers in both tenants (so the SOS customer match is
  // ambiguous and fails safe). Pins the decision that STOP still opts out
  // every phone-matched profile across tenants.
  const [tenantB] = await db
    .insert(tenantsTable)
    .values({ brandName: `StopE2E-B ${RUN}`, subdomain: `${RUN}-b`, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantBId = tenantB.id;
  const [profA] = await db
    .insert(clientProfilesTable)
    .values({ tenantId, name: `MultiA ${RUN}`, phone: PHONE_MULTI_TENANT })
    .returning({ id: clientProfilesTable.id });
  multiProfileAId = profA.id;
  const [profB] = await db
    .insert(clientProfilesTable)
    .values({ tenantId: tenantBId, name: `MultiB ${RUN}`, phone: PHONE_MULTI_TENANT })
    .returning({ id: clientProfilesTable.id });
  multiProfileBId = profB.id;
  const [custA] = await db
    .insert(sosCustomersTable)
    .values({ tenantId, name: `MultiCustA ${RUN}`, phone: PHONE_MULTI_TENANT, smsOptIn: true })
    .returning({ id: sosCustomersTable.id });
  multiCustomerAId = custA.id;
  const [custB] = await db
    .insert(sosCustomersTable)
    .values({ tenantId: tenantBId, name: `MultiCustB ${RUN}`, phone: PHONE_MULTI_TENANT, smsOptIn: true })
    .returning({ id: sosCustomersTable.id });
  multiCustomerBId = custB.id;
});

afterAll(async () => {
  await db
    .delete(messagesTable)
    .where(
      inArray(messagesTable.toNumber, [
        PHONE_CUSTOMER,
        PHONE_PROFILE_ONLY,
        PHONE_MULTI_TENANT,
      ]),
    );
  await db
    .delete(sosCustomersTable)
    .where(inArray(sosCustomersTable.id, [customerId, multiCustomerAId, multiCustomerBId]));
  // Cascades client_profiles rows.
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantId, tenantBId]));
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

// ---------------------------------------------------------------------------
// DECISION PIN: one phone matching concierge profiles in TWO tenants. STOP is
// a consent revocation attached to the phone number (TCPA/carrier compliance
// on a shared inbound line), so it must opt out EVERY phone-matched profile
// across tenants — even though the ambiguous SOS customer match fails safe
// (no sos_customers opt-in change). This is the only intentional cross-tenant
// write in the webhook; it only silences future sends, never exposes data.
// See applyOptInChange in routes/sos.ts.
// ---------------------------------------------------------------------------
describe("STOP from a phone matching profiles in two different tenants", () => {
  it("STOP opts out the phone-matched profiles in BOTH tenants", async () => {
    const res = await signedPost({
      From: PHONE_MULTI_TENANT,
      Body: "STOP",
      MessageSid: `SMstop${uniq}c`,
    });
    expect(res.status).toBe(200);

    const profs = await db
      .select({ id: clientProfilesTable.id, smsOptIn: clientProfilesTable.smsOptIn })
      .from(clientProfilesTable)
      .where(inArray(clientProfilesTable.id, [multiProfileAId, multiProfileBId]));
    expect(profs).toHaveLength(2);
    for (const p of profs) {
      expect(p.smsOptIn, `profile ${p.id} must be opted out cross-tenant`).toBe(false);
    }
  });

  it("the ambiguous SOS customer match fails safe: no sos_customers opt-in change", async () => {
    const custs = await db
      .select({ id: sosCustomersTable.id, smsOptIn: sosCustomersTable.smsOptIn })
      .from(sosCustomersTable)
      .where(inArray(sosCustomersTable.id, [multiCustomerAId, multiCustomerBId]));
    expect(custs).toHaveLength(2);
    for (const c of custs) {
      expect(c.smsOptIn, `ambiguous customer ${c.id} must be untouched`).toBe(true);
    }
  });

  it("sends addressed to either tenant's profile are skipped as opted_out", async () => {
    for (const profileId of [multiProfileAId, multiProfileBId]) {
      const rows = await sendAllKinds({
        clientProfileId: profileId,
        toNumber: PHONE_MULTI_TENANT,
      });
      for (const row of rows) {
        expect(row.status, `${row.kind} to profile ${profileId} must be skipped`).toBe("skipped");
        expect(row.errorCode).toBe("opted_out");
      }
    }
  });

  it("START symmetrically re-enables both tenants' profiles", async () => {
    const res = await signedPost({
      From: PHONE_MULTI_TENANT,
      Body: "START",
      MessageSid: `SMstart${uniq}c`,
    });
    expect(res.status).toBe(200);

    const profs = await db
      .select({ smsOptIn: clientProfilesTable.smsOptIn })
      .from(clientProfilesTable)
      .where(inArray(clientProfilesTable.id, [multiProfileAId, multiProfileBId]));
    for (const p of profs) expect(p.smsOptIn).toBe(true);
  });
});
