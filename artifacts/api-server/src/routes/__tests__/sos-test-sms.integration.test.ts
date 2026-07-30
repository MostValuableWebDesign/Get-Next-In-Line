import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, messagesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for the admin "send test text" endpoint
// (POST /api/sos/sms/test-send): verifies auth guarding, simulated-mode
// behavior in the test environment, the configurable default recipient
// (TEST_SMS_RECIPIENT env var), and that the send is recorded in the unified
// messages table with kind "test_send" so it appears in message history.
//
// Isolation: one throwaway tenant per run (rows cascade on tenant delete);
// legacy-scope sends use a unique per-run recipient so cleanup is exact.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME; // no Twilio connector lookup
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `testsms-${Date.now()}-${process.pid}`;
// Unique per-run recipient so legacy-scope cleanup never touches other rows.
const RUN_SUFFIX = String(Date.now() % 10_000_000).padStart(7, "0");
const CUSTOM_RECIPIENT = `+1404${RUN_SUFFIX}`;

let agent: ReturnType<typeof request.agent>;
let anonAgent: ReturnType<typeof request.agent>;
let tenantId: number;
const originalTestRecipient = process.env.TEST_SMS_RECIPIENT;

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  anonAgent = request.agent(app);
  agent.set("x-tenant-id", "legacy");
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `Test SMS ${RUN}`, subdomain: `${RUN}-a`, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;
});

afterAll(async () => {
  if (originalTestRecipient == null) delete process.env.TEST_SMS_RECIPIENT;
  else process.env.TEST_SMS_RECIPIENT = originalTestRecipient;
  // Tenant-scoped rows cascade; legacy-scope test rows are matched exactly.
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  await db
    .delete(messagesTable)
    .where(
      and(eq(messagesTable.kind, "test_send"), eq(messagesTable.toNumber, CUSTOM_RECIPIENT)),
    );
});

describe("POST /api/sos/sms/test-send", () => {
  it("rejects unauthenticated callers", async () => {
    await anonAgent
      .post("/api/sos/sms/test-send")
      .set("x-tenant-id", "legacy")
      .send({})
      .expect(401);
  });

  it("rejects requests without tenant context", async () => {
    const res = await agent
      .post("/api/sos/sms/test-send")
      .set("x-tenant-id", "")
      .send({});
    expect(res.status).toBe(400);
  });

  it("sends to the configured default recipient in simulated mode and records the message", async () => {
    process.env.TEST_SMS_RECIPIENT = CUSTOM_RECIPIENT;
    const res = await agent.post("/api/sos/sms/test-send").send({}).expect(201);

    expect(res.body.smsMode).toBe("simulated");
    expect(res.body.defaultRecipient).toBe(CUSTOM_RECIPIENT);
    expect(res.body.message.kind).toBe("test_send");
    expect(res.body.message.toNumber).toBe(CUSTOM_RECIPIENT);
    expect(res.body.message.deliveryStatus).toBe("simulated");
    expect(res.body.message.customerId).toBeNull();

    // Recorded in the unified messages table like every other outbound text.
    const [row] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, res.body.message.id));
    expect(row).toBeDefined();
    expect(row.kind).toBe("test_send");
    expect(row.direction).toBe("outbound");
    expect(row.origin).toBe("operational");
    expect(row.status).toBe("simulated");
    expect(row.tenantId).toBeNull(); // legacy scope
  });

  it("falls back to the platform default recipient when the env var is unset", async () => {
    delete process.env.TEST_SMS_RECIPIENT;
    const res = await agent
      .post("/api/sos/sms/test-send")
      .set("x-tenant-id", String(tenantId))
      .send({})
      .expect(201);
    expect(res.body.defaultRecipient).toBe("+14703467558");
    expect(res.body.message.toNumber).toBe("+14703467558");

    const [row] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, res.body.message.id));
    expect(row.tenantId).toBe(tenantId); // stamped with the caller's scope
  });

  it("honors an explicit recipient override and normalizes it to E.164", async () => {
    const res = await agent
      .post("/api/sos/sms/test-send")
      .set("x-tenant-id", String(tenantId))
      .send({ toNumber: `(404) ${RUN_SUFFIX.slice(0, 3)}-${RUN_SUFFIX.slice(3)}` })
      .expect(201);
    expect(res.body.message.toNumber).toBe(CUSTOM_RECIPIENT);
    expect(res.body.message.kind).toBe("test_send");
  });

  it("rejects an unusable recipient number with a 400", async () => {
    const res = await agent
      .post("/api/sos/sms/test-send")
      .set("x-tenant-id", String(tenantId))
      .send({ toNumber: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("appears in the SOS message history for its scope", async () => {
    const res = await agent
      .get("/api/sos/messages")
      .set("x-tenant-id", String(tenantId))
      .expect(200);
    const testSends = res.body.filter(
      (m: { kind: string }) => m.kind === "test_send",
    );
    expect(testSends.length).toBeGreaterThan(0);
  });
});
