import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, sosCustomersTable, messagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Staff can retry a failed outbound text with one click. The retry endpoint
// re-dispatches through the unified send path (so opt-out and no-phone
// guards still apply), records a NEW messages row linked to the original via
// payload.retryOf, and is tenant-scoped. Only failed outbound messages are
// retryable.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `retrysms-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantId: number;
let otherTenantId: number;
let customerId: number;
let optedOutCustomerId: number;

async function insertMessage(values: Partial<typeof messagesTable.$inferInsert>) {
  const [row] = await db
    .insert(messagesTable)
    .values({
      tenantId,
      customerId,
      direction: "outbound",
      kind: "manual",
      channel: "sms",
      toNumber: "+15550108888",
      body: `retry test ${RUN}`,
      status: "failed",
      errorCode: "30003",
      ...values,
    } as typeof messagesTable.$inferInsert)
    .returning();
  return row;
}

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .set("x-tenant-id", "legacy")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `RetrySms A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `RetrySms B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  tenantId = tenants[0].id;
  otherTenantId = tenants[1].id;

  const customers = await db
    .insert(sosCustomersTable)
    .values([
      { tenantId, name: `Retry ${RUN}`, phone: "+15550108888" },
      { tenantId, name: `RetryOptOut ${RUN}`, phone: "+15550108899", smsOptIn: false },
    ])
    .returning({ id: sosCustomersTable.id });
  customerId = customers[0].id;
  optedOutCustomerId = customers[1].id;
});

afterAll(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, otherTenantId));
});

describe("POST /api/sos/messages/:id/retry", () => {
  it("re-sends a failed message as a new row linked via payload.retryOf", async () => {
    const original = await insertMessage({});
    const res = await agent
      .post(`/api/sos/messages/${original.id}/retry`)
      .set("x-tenant-id", String(tenantId))
      .expect(201);

    // New row, not a mutation of the original.
    expect(res.body.id).not.toBe(original.id);
    expect(res.body.body).toBe(original.body);
    expect(res.body.kind).toBe("manual");
    // Simulated mode (no Twilio creds in tests) — a fresh delivery attempt.
    expect(res.body.deliveryStatus).toBe("simulated");
    expect(res.body.customerName).toBe(`Retry ${RUN}`);

    const [retried] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, res.body.id));
    expect((retried.payload as Record<string, unknown>).retryOf).toBe(original.id);
    // Original row untouched.
    const [orig] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, original.id));
    expect(orig.status).toBe("failed");
  });

  it("applies the opt-out guard on retry (recorded as skipped)", async () => {
    const original = await insertMessage({
      customerId: optedOutCustomerId,
      toNumber: "+15550108899",
    });
    const res = await agent
      .post(`/api/sos/messages/${original.id}/retry`)
      .set("x-tenant-id", String(tenantId))
      .expect(201);
    expect(res.body.deliveryStatus).toBe("skipped");
    expect(res.body.errorCode).toBe("opted_out");
  });

  it("applies the no-phone guard on retry", async () => {
    const original = await insertMessage({ customerId: null, toNumber: null });
    const res = await agent
      .post(`/api/sos/messages/${original.id}/retry`)
      .set("x-tenant-id", String(tenantId))
      .expect(201);
    expect(res.body.deliveryStatus).toBe("skipped");
    expect(res.body.errorCode).toBe("no_phone");
  });

  it("rejects non-failed and inbound messages with 409", async () => {
    const sent = await insertMessage({ status: "sent", errorCode: null });
    await agent
      .post(`/api/sos/messages/${sent.id}/retry`)
      .set("x-tenant-id", String(tenantId))
      .expect(409);

    const inbound = await insertMessage({
      direction: "inbound",
      status: "received",
      errorCode: null,
    });
    await agent
      .post(`/api/sos/messages/${inbound.id}/retry`)
      .set("x-tenant-id", String(tenantId))
      .expect(409);
  });

  it("is tenant-scoped: another tenant's message 404s, as does a bogus id", async () => {
    const original = await insertMessage({});
    await agent
      .post(`/api/sos/messages/${original.id}/retry`)
      .set("x-tenant-id", String(otherTenantId))
      .expect(404);
    await agent
      .post(`/api/sos/messages/999999999/retry`)
      .set("x-tenant-id", String(tenantId))
      .expect(404);
  });
});
