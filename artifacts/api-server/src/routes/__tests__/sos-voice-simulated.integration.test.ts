import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, messagesTable } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// The voice webhook must keep working with NO Twilio credentials at all
// (simulated mode): the caller still gets TwiML and the SMS bridge degrades
// to a simulated send, consistent with the simulated-SMS pattern.
// ---------------------------------------------------------------------------

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN; // ← no credentials whatsoever

const uniq = String(Date.now()).slice(-7);
const PHONE_CALLER = `+1620${uniq}`;

let app: import("express").Express;

beforeAll(async () => {
  app = (await import("../../app")).default;
});

afterAll(async () => {
  await db.delete(messagesTable).where(inArray(messagesTable.toNumber, [PHONE_CALLER]));
});

describe("voice webhook without Twilio credentials (simulated mode)", () => {
  it("answers with TwiML, logs the call, and records a simulated SMS follow-up", async () => {
    const res = await request(app)
      .post("/api/sos/twilio/voice")
      .type("form")
      .send({ From: PHONE_CALLER, CallSid: `CAsim${uniq}` });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("xml");
    expect(res.text).toContain("<Record");

    const [call] = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.toNumber, PHONE_CALLER),
          eq(messagesTable.kind, "voice_call"),
        ),
      )
      .orderBy(desc(messagesTable.id))
      .limit(1);
    expect(call).toBeDefined();
    expect(call.status).toBe("received");

    const [sms] = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.toNumber, PHONE_CALLER),
          eq(messagesTable.direction, "outbound"),
        ),
      )
      .orderBy(desc(messagesTable.id))
      .limit(1);
    expect(sms).toBeDefined();
    expect(sms.kind).toBe("ai_followup");
    expect(sms.status).toBe("simulated");
  });
});
