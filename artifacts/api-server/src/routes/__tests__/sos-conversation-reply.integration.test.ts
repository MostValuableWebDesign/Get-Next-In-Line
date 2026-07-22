import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, sosCustomersTable, messagesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for staff replies from the conversation view: replies
// go through POST /sos/messages and must respect the customer's SMS opt-in
// flag (409 for opted-out customers; nothing recorded).
//
// Isolation: unique per-run customers; only rows created here are cleaned up.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME; // no Twilio connector lookup
delete process.env.TWILIO_ACCOUNT_SID; // outbound stays simulated
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `convreply-${Date.now()}-${process.pid}`;
const uniq = String(Date.now()).slice(-7);

let agent: ReturnType<typeof request.agent>;
let optedIn: { id: number };
let optedOut: { id: number };

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const rows = await db
    .insert(sosCustomersTable)
    .values([
      { name: `Reply OptIn ${RUN}`, phone: `+1559${uniq}`, smsOptIn: true },
      { name: `Reply OptOut ${RUN}`, phone: `+1560${uniq}`, smsOptIn: false },
    ])
    .returning({ id: sosCustomersTable.id });
  optedIn = rows[0];
  optedOut = rows[1];
});

afterAll(async () => {
  const ids = [optedIn?.id, optedOut?.id].filter((x): x is number => x != null);
  if (ids.length > 0) {
    await db.delete(messagesTable).where(inArray(messagesTable.customerId, ids));
    await db.delete(sosCustomersTable).where(inArray(sosCustomersTable.id, ids));
  }
});

describe("conversation replies (POST /sos/messages)", () => {
  it("sends a manual reply to an opted-in customer and records it in the log", async () => {
    const body = `Reply body ${RUN}`;
    const res = await agent
      .post("/api/sos/messages")
      .send({ customerId: optedIn.id, body, kind: "manual" })
      .expect(201);
    expect(res.body.customerId).toBe(optedIn.id);
    expect(res.body.direction).toBe("outbound");
    expect(res.body.body).toBe(body);

    // The reply is visible in the message log the conversation view reads.
    const list = await agent.get("/api/sos/messages?limit=200").expect(200);
    const mine = list.body.find((m: { id: number }) => m.id === res.body.id);
    expect(mine).toBeDefined();
    expect(mine.body).toBe(body);
  });

  it("rejects replies to an opted-out customer with 409 and records nothing", async () => {
    const res = await agent
      .post("/api/sos/messages")
      .send({ customerId: optedOut.id, body: `Should not send ${RUN}`, kind: "manual" })
      .expect(409);
    expect(res.body.message).toMatch(/opted out/i);

    const recorded = await db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(eq(messagesTable.customerId, optedOut.id));
    expect(recorded).toHaveLength(0);
  });
});
