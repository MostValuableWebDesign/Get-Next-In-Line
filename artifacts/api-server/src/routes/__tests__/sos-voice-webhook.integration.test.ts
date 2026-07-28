import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import twilio from "twilio";
import {
  db,
  sosCustomersTable,
  messagesTable,
  tenantsTable,
  sosSettingsTable,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for the Twilio inbound-VOICE webhook. Signature
// validation uses a test auth token: only TWILIO_AUTH_TOKEN is set (no
// ACCOUNT_SID), so the SMS follow-up bridge stays "simulated" while the
// webhook can verify real Twilio signatures.
// ---------------------------------------------------------------------------

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME; // skip connector lookup
delete process.env.TWILIO_ACCOUNT_SID; // keep outbound in simulated mode
const AUTH_TOKEN = "test-auth-token-voice123";
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;

const RUN = `voice-${Date.now()}-${process.pid}`;
const HOST = "sos-voice-test.local";
const VOICE_PATH = "/api/sos/twilio/voice";
const RECORDING_PATH = "/api/sos/twilio/voice/recording";

let app: import("express").Express;

const uniq = String(Date.now()).slice(-7);
const PHONE_CALLER = `+1615${uniq}`; // tenant customer
const PHONE_UNKNOWN = `+1616${uniq}`;
const PHONE_OPTED_OUT = `+1617${uniq}`;
const PHONE_TENANT_LINE = `+1618${uniq}`; // tenant A's Twilio number
const PHONE_QUIET_LINE = `+1619${uniq}`; // tenant B's (receptionist off)
const ALL_PHONES = [PHONE_CALLER, PHONE_UNKNOWN, PHONE_OPTED_OUT];

let tenantAId: number;
let tenantBId: number;
let customerId: number;
let optedOutId: number;

function signedPost(path: string, params: Record<string, string>) {
  const url = `http://${HOST}${path}`;
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app)
    .post(path)
    .set("Host", HOST)
    .set("X-Twilio-Signature", signature)
    .type("form")
    .send(params);
}

async function latestInboundVoice(from: string, kind: string) {
  const [row] = await db
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.direction, "inbound"),
        eq(messagesTable.toNumber, from),
        eq(messagesTable.kind, kind),
      ),
    )
    .orderBy(desc(messagesTable.id))
    .limit(1);
  return row;
}

async function outboundTo(from: string) {
  return db
    .select()
    .from(messagesTable)
    .where(
      and(eq(messagesTable.direction, "outbound"), eq(messagesTable.toNumber, from)),
    )
    .orderBy(desc(messagesTable.id));
}

beforeAll(async () => {
  app = (await import("../../app")).default;

  const [tenantA] = await db
    .insert(tenantsTable)
    .values({ brandName: `Voice A ${RUN}`, subdomain: `${RUN}-a`, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantAId = tenantA.id;
  const [tenantB] = await db
    .insert(tenantsTable)
    .values({ brandName: `Voice B ${RUN}`, subdomain: `${RUN}-b`, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantBId = tenantB.id;

  await db.insert(sosSettingsTable).values([
    {
      tenantId: tenantAId,
      businessName: `Voice Salon ${RUN}`,
      smsFromNumber: PHONE_TENANT_LINE,
      aiReceptionistEnabled: true,
    },
    {
      tenantId: tenantBId,
      businessName: `Quiet Shop ${RUN}`,
      smsFromNumber: PHONE_QUIET_LINE,
      aiReceptionistEnabled: false,
    },
  ]);

  const [cust] = await db
    .insert(sosCustomersTable)
    .values({ name: `Cally ${RUN}`, phone: PHONE_CALLER, tenantId: tenantAId })
    .returning({ id: sosCustomersTable.id });
  customerId = cust.id;
  const [optedOut] = await db
    .insert(sosCustomersTable)
    .values({
      name: `Optout ${RUN}`,
      phone: PHONE_OPTED_OUT,
      tenantId: tenantAId,
      smsOptIn: false,
    })
    .returning({ id: sosCustomersTable.id });
  optedOutId = optedOut.id;
});

afterAll(async () => {
  await db
    .delete(messagesTable)
    .where(inArray(messagesTable.customerId, [customerId, optedOutId]));
  await db.delete(messagesTable).where(inArray(messagesTable.toNumber, ALL_PHONES));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantAId, tenantBId]));
});

describe("POST /api/sos/twilio/voice — signature validation", () => {
  it("rejects an invalid signature and logs nothing", async () => {
    const res = await request(app)
      .post(VOICE_PATH)
      .set("Host", HOST)
      .set("X-Twilio-Signature", "bogus")
      .type("form")
      .send({ From: PHONE_UNKNOWN, To: PHONE_TENANT_LINE });
    expect(res.status).toBe(403);
    expect(await latestInboundVoice(PHONE_UNKNOWN, "voice_call")).toBeUndefined();
  });
});

describe("inbound call handling", () => {
  it("greets with the tenant's branding, logs the call, and texts a booking link", async () => {
    const res = await signedPost(VOICE_PATH, {
      From: PHONE_CALLER,
      To: PHONE_TENANT_LINE,
      CallSid: `CAvoice${uniq}1`,
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("xml");
    // Branded greeting + voicemail fallback in the TwiML.
    expect(res.text).toContain(`Voice Salon ${RUN}`);
    expect(res.text).toContain("texted you a booking link");
    expect(res.text).toContain("<Record");
    expect(res.text).toContain(RECORDING_PATH);

    // Call logged as an inbound voice message, matched to the customer.
    const call = await latestInboundVoice(PHONE_CALLER, "voice_call");
    expect(call).toBeDefined();
    expect(call.customerId).toBe(customerId);
    expect(call.tenantId).toBe(tenantAId);
    expect(call.channel).toBe("voice");
    expect(call.providerSid).toBe(`CAvoice${uniq}1`);

    // SMS bridge: an ai_followup with a fully-qualified tenant booking link,
    // simulated (no Twilio account SID configured).
    const [sms] = await outboundTo(PHONE_CALLER);
    expect(sms).toBeDefined();
    expect(sms.kind).toBe("ai_followup");
    expect(sms.status).toBe("simulated");
    expect(sms.body).toMatch(/https?:\/\/\S+\/book\//);
    expect(sms.body).toContain(`${RUN}-a`);
    expect(sms.tenantId).toBe(tenantAId);
    expect(sms.customerId).toBe(customerId);
  });

  it("logs unknown callers with the resolved tenant scope and still texts them", async () => {
    const res = await signedPost(VOICE_PATH, {
      From: PHONE_UNKNOWN,
      To: PHONE_TENANT_LINE,
      CallSid: `CAvoice${uniq}2`,
    });
    expect(res.status).toBe(200);
    const call = await latestInboundVoice(PHONE_UNKNOWN, "voice_call");
    expect(call).toBeDefined();
    expect(call.customerId).toBeNull();
    expect(call.tenantId).toBe(tenantAId);
    const [sms] = await outboundTo(PHONE_UNKNOWN);
    expect(sms).toBeDefined();
    expect(sms.kind).toBe("ai_followup");
  });

  it("skips the SMS bridge when the receptionist is disabled, but still greets", async () => {
    const res = await signedPost(VOICE_PATH, {
      From: PHONE_UNKNOWN,
      To: PHONE_QUIET_LINE,
      CallSid: `CAvoice${uniq}3`,
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain(`Quiet Shop ${RUN}`);
    expect(res.text).not.toContain("texted you");
    // No new outbound (only the one from the previous test).
    const outbound = await outboundTo(PHONE_UNKNOWN);
    expect(outbound.length).toBe(1);
    // Call still logged under tenant B's scope.
    const call = await latestInboundVoice(PHONE_UNKNOWN, "voice_call");
    expect(call.tenantId).toBe(tenantBId);
  });

  it("respects an opted-out caller: call logged, follow-up skipped, no 'texted you' claim", async () => {
    const res = await signedPost(VOICE_PATH, {
      From: PHONE_OPTED_OUT,
      To: PHONE_TENANT_LINE,
      CallSid: `CAvoice${uniq}4`,
    });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("texted you");
    const call = await latestInboundVoice(PHONE_OPTED_OUT, "voice_call");
    expect(call.customerId).toBe(optedOutId);
    const [sms] = await outboundTo(PHONE_OPTED_OUT);
    // The send is recorded but guarded as skipped (opted out).
    expect(sms.status).toBe("skipped");
    expect(sms.errorCode).toBe("opted_out");
  });
});

describe("POST /api/sos/twilio/voice/recording — voicemail capture", () => {
  it("logs the voicemail with the recording link, matched to the customer", async () => {
    const recordingUrl = `https://api.twilio.com/recordings/RE${uniq}`;
    const res = await signedPost(RECORDING_PATH, {
      From: PHONE_CALLER,
      To: PHONE_TENANT_LINE,
      CallSid: `CAvoice${uniq}1`,
      RecordingSid: `RE${uniq}`,
      RecordingUrl: recordingUrl,
      RecordingDuration: "42",
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("xml");
    expect(res.text).toContain("we got your message");

    const vm = await latestInboundVoice(PHONE_CALLER, "voicemail");
    expect(vm).toBeDefined();
    expect(vm.customerId).toBe(customerId);
    expect(vm.tenantId).toBe(tenantAId);
    expect(vm.channel).toBe("voice");
    expect(vm.body).toContain(recordingUrl);
    expect(vm.body).toContain("42s");
    expect((vm.payload as Record<string, unknown>).recordingUrl).toBe(recordingUrl);
  });

  it("rejects an invalid signature", async () => {
    const res = await request(app)
      .post(RECORDING_PATH)
      .set("Host", HOST)
      .set("X-Twilio-Signature", "bogus")
      .type("form")
      .send({ From: PHONE_CALLER, To: PHONE_TENANT_LINE });
    expect(res.status).toBe(403);
  });
});

describe("timeline", () => {
  it("surfaces the call and voicemail as ai_call entries on the customer timeline", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ password: process.env.ADMIN_PASSWORD || "admin" });
    // Timeline requires an authenticated session; skip assertion gracefully
    // if the test environment has no admin password configured.
    if (login.status !== 200) return;
    const cookie = login.headers["set-cookie"];
    const res = await request(app)
      .get(`/api/sos/customers/${customerId}/timeline`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(tenantAId));
    expect(res.status).toBe(200);
    const voiceEntries = res.body.filter(
      (e: { channel: string; kind: string }) =>
        e.channel === "ai_call" && (e.kind === "voice_call" || e.kind === "voicemail"),
    );
    expect(voiceEntries.length).toBeGreaterThanOrEqual(2);
  });
});
