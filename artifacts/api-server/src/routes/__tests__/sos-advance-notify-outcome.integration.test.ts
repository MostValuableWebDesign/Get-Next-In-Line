import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, sosCustomersTable, sosVisitsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Regression: the "notify" visit-advance surfaces the outcome of the
// "you're next" SMS on the response (`notification`) so staff can see when
// the customer was NOT reached — instead of the failure being invisible.
//  - reachable customer  → attempted: true, status is the message status
//  - opted-out customer  → attempted: false, status "skipped", with a reason
//  - non-notify actions  → notification is null/absent
// The queue transition itself must always succeed regardless of the SMS.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `notifyout-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantId = 0;

async function makeVisit(customer: { name: string; phone: string | null; smsOptIn: boolean }) {
  const [c] = await db
    .insert(sosCustomersTable)
    .values({ tenantId, name: customer.name, phone: customer.phone, smsOptIn: customer.smsOptIn })
    .returning();
  const [v] = await db
    .insert(sosVisitsTable)
    .values({
      tenantId,
      customerId: c.id,
      serviceType: `svc-${RUN}`,
      status: "assigned",
      checkedInAt: new Date(),
    })
    .returning();
  return v;
}

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);
  const [t] = await db
    .insert(tenantsTable)
    .values({ brandName: `Notify Out ${RUN}`, subdomain: `${RUN}-t`, status: "active" })
    .returning();
  tenantId = t.id;
});

afterAll(async () => {
  if (tenantId) await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

describe("visit advance notify outcome", () => {
  it("reports the SMS outcome for a reachable customer", async () => {
    const visit = await makeVisit({ name: "Reachable", phone: "+15559410001", smsOptIn: true });
    const res = await agent
      .post(`/api/sos/visits/${visit.id}/advance`)
      .set("x-tenant-id", String(tenantId))
      .send({ action: "notify" })
      .expect(200);
    expect(res.body.status).toBe("notified");
    expect(res.body.notification).toBeTruthy();
    expect(res.body.notification.attempted).toBe(true);
    // Test env has no Twilio — simulated delivery counts as a send.
    expect(["sent", "simulated", "delivered"]).toContain(res.body.notification.status);
  });

  it("surfaces a skipped notification when the customer cannot be texted, but still advances", async () => {
    const visit = await makeVisit({ name: "OptedOut", phone: "+15559410002", smsOptIn: false });
    const res = await agent
      .post(`/api/sos/visits/${visit.id}/advance`)
      .set("x-tenant-id", String(tenantId))
      .send({ action: "notify" })
      .expect(200);
    expect(res.body.status).toBe("notified");
    expect(res.body.notification).toEqual({
      attempted: false,
      status: "skipped",
      error: "Customer has opted out of SMS",
    });
  });

  it("leaves notification null on non-notify transitions", async () => {
    const visit = await makeVisit({ name: "Starter", phone: "+15559410003", smsOptIn: true });
    const res = await agent
      .post(`/api/sos/visits/${visit.id}/advance`)
      .set("x-tenant-id", String(tenantId))
      .send({ action: "start_service" })
      .expect(200);
    expect(res.body.status).toBe("in_service");
    expect(res.body.notification ?? null).toBeNull();
  });
});
