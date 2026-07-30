import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, sosCustomersTable, messagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// The dashboard must surface today's failed outbound SMS attempts
// (messagesFailedToday) so Twilio rejections never go unnoticed. Failed
// counts are scoped strictly to the requesting tenant, count only
// operational outbound "failed" rows from today, and exclude skipped/sent/
// delivered rows and marketing-origin sends.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `failsms-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantId: number;
let otherTenantId: number;
let customerId: number;

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  agent.set("x-tenant-id", "legacy");
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `FailSms A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `FailSms B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  tenantId = tenants[0].id;
  otherTenantId = tenants[1].id;

  const [c] = await db
    .insert(sosCustomersTable)
    .values({ tenantId, name: `FailSms ${RUN}`, phone: "+15550107777" })
    .returning({ id: sosCustomersTable.id });
  customerId = c.id;

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const base = {
    customerId,
    direction: "outbound",
    kind: "manual",
    channel: "sms",
    toNumber: "+15550107777",
  } as const;
  await db.insert(messagesTable).values([
    // Counted: two operational outbound failures today for this tenant.
    { ...base, tenantId, body: `fail1 ${RUN}`, status: "failed", errorCode: "21211" },
    { ...base, tenantId, body: `fail2 ${RUN}`, status: "failed", errorCode: "30003" },
    // Not counted: successful and skipped sends.
    { ...base, tenantId, body: `sent ${RUN}`, status: "sent" },
    { ...base, tenantId, body: `skipped ${RUN}`, status: "skipped", errorCode: "opted_out" },
    // Not counted: failed but yesterday.
    { ...base, tenantId, body: `old ${RUN}`, status: "failed", createdAt: yesterday },
    // Not counted: failed operational email — the counter is SMS-only.
    {
      ...base,
      tenantId,
      channel: "email",
      toNumber: null,
      toEmail: `fail-${RUN}@example.com`,
      body: `email ${RUN}`,
      status: "failed",
    },
    // Not counted: marketing-origin failure (surfaced elsewhere).
    { ...base, tenantId, origin: "marketing", body: `mkt ${RUN}`, status: "failed" },
    // Not counted: another tenant's failure.
    { ...base, tenantId: otherTenantId, customerId: null, body: `other ${RUN}`, status: "failed" },
    // Not counted: inbound row (only outbound sends can "fail").
    { ...base, tenantId, direction: "inbound", body: `in ${RUN}`, status: "received" },
  ]);
});

afterAll(async () => {
  // Messages/customers cascade on tenant delete.
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, otherTenantId));
});

describe("GET /api/sos/dashboard messagesFailedToday", () => {
  it("counts only today's operational outbound failures for the tenant", async () => {
    const res = await agent
      .get("/api/sos/dashboard")
      .set("x-tenant-id", String(tenantId))
      .expect(200);
    expect(res.body.messagesFailedToday).toBe(2);
  });

  it("does not leak another tenant's failures", async () => {
    const res = await agent
      .get("/api/sos/dashboard")
      .set("x-tenant-id", String(otherTenantId))
      .expect(200);
    expect(res.body.messagesFailedToday).toBe(1);
  });

  it("failed messages carry error details in the message list", async () => {
    const res = await agent
      .get("/api/sos/messages")
      .set("x-tenant-id", String(tenantId))
      .expect(200);
    const failed = res.body.filter((m: any) => m.deliveryStatus === "failed");
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(failed.some((m: any) => m.errorCode === "21211")).toBe(true);
  });
});
