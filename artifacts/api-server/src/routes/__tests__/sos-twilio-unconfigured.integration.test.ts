import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, messagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Twilio webhooks when NO auth token is configured: both endpoints must
// respond 503 ("not configured" simulated mode) and act on nothing — even a
// request that looks plausible must not be processed, because without the
// auth token its signature cannot be verified at all.
//
// The token sources are removed BEFORE the app (and the sms lib's creds
// cache) is imported; originals are restored in afterAll. Test files run
// serially and sibling suites set their own TWILIO_* env at file top, so
// this cannot leak into them.
// ---------------------------------------------------------------------------

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
const saved = {
  authToken: process.env.TWILIO_AUTH_TOKEN,
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  connectors: process.env.REPLIT_CONNECTORS_HOSTNAME,
};
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;

const RUN = `uncfg-${Date.now()}-${process.pid}`;
const PHONE = "+15553219876";
const SID = `SM${RUN}`;

let app: import("express").Express;

beforeAll(async () => {
  app = (await import("../../app")).default;
});

afterAll(async () => {
  await db.delete(messagesTable).where(eq(messagesTable.providerSid, SID));
  if (saved.authToken != null) process.env.TWILIO_AUTH_TOKEN = saved.authToken;
  if (saved.accountSid != null) process.env.TWILIO_ACCOUNT_SID = saved.accountSid;
  if (saved.connectors != null) process.env.REPLIT_CONNECTORS_HOSTNAME = saved.connectors;
});

describe("Twilio webhooks with no auth token configured", () => {
  it("POST /api/sos/twilio/inbound responds 503 and records nothing", async () => {
    const res = await request(app)
      .post("/api/sos/twilio/inbound")
      .set("X-Twilio-Signature", "anything")
      .type("form")
      .send({ From: PHONE, Body: "YES", MessageSid: SID });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ message: "Inbound SMS is not configured" });
    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.providerSid, SID));
    expect(rows).toHaveLength(0);
  });

  it("POST /api/sos/twilio/inbound responds 503 even with no signature header", async () => {
    const res = await request(app)
      .post("/api/sos/twilio/inbound")
      .type("form")
      .send({ From: PHONE, Body: "hello" });
    expect(res.status).toBe(503);
  });

  it("POST /api/sos/twilio/status responds 503 and applies nothing", async () => {
    const res = await request(app)
      .post("/api/sos/twilio/status")
      .set("X-Twilio-Signature", "anything")
      .type("form")
      .send({ MessageSid: SID, MessageStatus: "delivered" });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ message: "SMS status callbacks are not configured" });
  });

  it("POST /api/sos/twilio/status responds 503 even with no signature header", async () => {
    const res = await request(app)
      .post("/api/sos/twilio/status")
      .type("form")
      .send({ MessageSid: SID, MessageStatus: "delivered" });
    expect(res.status).toBe(503);
  });
});
