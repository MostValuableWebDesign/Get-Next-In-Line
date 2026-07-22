import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import twilio from "twilio";
import { db, sosCustomersTable, messagesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for the Twilio StatusCallback webhook: signature
// validation and delivery-status updates against the unified messages table.
// ---------------------------------------------------------------------------

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = "test-auth-token-status";
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;

const RUN = `status-${Date.now()}-${process.pid}`;
const HOST = "sos-status-test.local";
const PATH = "/api/sos/twilio/status";
const URL = `http://${HOST}${PATH}`;

let app: import("express").Express;
let customerId: number;
const sids = {
  delivered: `SM${RUN}-del`,
  failed: `SM${RUN}-fail`,
  ordered: `SM${RUN}-ord`,
};

function signedPost(params: Record<string, string>) {
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, URL, params);
  return request(app)
    .post(PATH)
    .set("Host", HOST)
    .set("X-Twilio-Signature", signature)
    .type("form")
    .send(params);
}

async function messageBySid(sid: string) {
  const [row] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.providerSid, sid));
  return row;
}

beforeAll(async () => {
  app = (await import("../../app")).default;
  const [c] = await db
    .insert(sosCustomersTable)
    .values({ name: `Status ${RUN}`, phone: null })
    .returning({ id: sosCustomersTable.id });
  customerId = c.id;
  await db.insert(messagesTable).values(
    Object.values(sids).map((sid) => ({
      customerId,
      direction: "outbound",
      kind: "manual",
      channel: "sms",
      toNumber: "+15550009999",
      body: `test ${sid}`,
      status: "sent",
      providerSid: sid,
    })),
  );
});

afterAll(async () => {
  await db
    .delete(messagesTable)
    .where(inArray(messagesTable.providerSid, Object.values(sids)));
  await db.delete(sosCustomersTable).where(eq(sosCustomersTable.id, customerId));
});

describe("POST /api/sos/twilio/status", () => {
  it("rejects an unsigned request", async () => {
    const res = await request(app)
      .post(PATH)
      .set("Host", HOST)
      .type("form")
      .send({ MessageSid: sids.delivered, MessageStatus: "delivered" });
    expect(res.status).toBe(403);
    expect((await messageBySid(sids.delivered)).status).toBe("sent");
  });

  it("rejects a badly signed request", async () => {
    const res = await request(app)
      .post(PATH)
      .set("Host", HOST)
      .set("X-Twilio-Signature", "bogus")
      .type("form")
      .send({ MessageSid: sids.delivered, MessageStatus: "delivered" });
    expect(res.status).toBe(403);
  });

  it("requires MessageSid and MessageStatus", async () => {
    const res = await signedPost({ MessageStatus: "delivered" });
    expect(res.status).toBe(400);
  });

  it("marks the matching message delivered", async () => {
    const res = await signedPost({
      MessageSid: sids.delivered,
      MessageStatus: "delivered",
    });
    expect(res.status).toBe(204);
    const row = await messageBySid(sids.delivered);
    expect(row.status).toBe("delivered");
    expect(row.errorCode).toBeNull();
  });

  it("marks a failed message with the Twilio error code", async () => {
    const res = await signedPost({
      MessageSid: sids.failed,
      MessageStatus: "undelivered",
      ErrorCode: "30003",
    });
    expect(res.status).toBe(204);
    const row = await messageBySid(sids.failed);
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("30003");
  });

  it("never downgrades a final status via an out-of-order 'sent' callback", async () => {
    await signedPost({ MessageSid: sids.ordered, MessageStatus: "delivered" });
    const res = await signedPost({ MessageSid: sids.ordered, MessageStatus: "sent" });
    expect(res.status).toBe(204);
    expect((await messageBySid(sids.ordered)).status).toBe("delivered");
  });

  it("ignores interim statuses and unknown SIDs without error", async () => {
    expect((await signedPost({ MessageSid: sids.delivered, MessageStatus: "queued" })).status).toBe(204);
    expect((await signedPost({ MessageSid: "SMnope", MessageStatus: "delivered" })).status).toBe(204);
    expect((await messageBySid(sids.delivered)).status).toBe("delivered");
  });
});
