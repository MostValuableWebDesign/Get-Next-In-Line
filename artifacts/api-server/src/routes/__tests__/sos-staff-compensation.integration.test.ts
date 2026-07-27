import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for staff profiles with compensation models: CRUD +
// per-model term validation, tenant scoping, checkout staff attribution, and
// the per-staff earnings summary (commission from persisted payment amounts;
// fee/rent due per cadence).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `staffcomp-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantA: number;
let tenantB: number;

const asTenant = (id: number) => ({ "x-tenant-id": String(id) });

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Staff A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `Staff B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  tenantA = tenants[0].id;
  tenantB = tenants[1].id;
});

afterAll(async () => {
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantA, tenantB]));
});

describe("staff CRUD & compensation validation", () => {
  it("creates a commission staff member and rejects mismatched terms", async () => {
    const res = await agent
      .post("/api/sos/staff")
      .set(asTenant(tenantA))
      .send({ name: `Casey ${RUN}`, compensationType: "commission", commissionPercent: 60 })
      .expect(201);
    expect(res.body.commissionPercent).toBe(60);
    expect(res.body.amount).toBeNull();
    expect(res.body.isActive).toBe(true);

    // commission requires a percent
    await agent
      .post("/api/sos/staff")
      .set(asTenant(tenantA))
      .send({ name: `Bad ${RUN}`, compensationType: "commission" })
      .expect(400);
    // flat fee requires amount + cadence
    await agent
      .post("/api/sos/staff")
      .set(asTenant(tenantA))
      .send({ name: `Bad2 ${RUN}`, compensationType: "flat_fee", amount: 500 })
      .expect(400);
  });

  it("scopes staff per tenant", async () => {
    await agent
      .post("/api/sos/staff")
      .set(asTenant(tenantB))
      .send({ name: `Riley ${RUN}`, compensationType: "booth_rent", amount: 250, cadence: "weekly" })
      .expect(201);

    const a = await agent.get("/api/sos/staff").set(asTenant(tenantA)).expect(200);
    const b = await agent.get("/api/sos/staff").set(asTenant(tenantB)).expect(200);
    expect(a.body.map((s: any) => s.name)).toContain(`Casey ${RUN}`);
    expect(a.body.map((s: any) => s.name)).not.toContain(`Riley ${RUN}`);
    expect(b.body.map((s: any) => s.name)).toContain(`Riley ${RUN}`);
  });

  it("switches compensation model on update, dropping stale terms", async () => {
    const created = await agent
      .post("/api/sos/staff")
      .set(asTenant(tenantA))
      .send({ name: `Switch ${RUN}`, compensationType: "commission", commissionPercent: 40 })
      .expect(201);

    // Switching without the new model's terms is rejected
    await agent
      .patch(`/api/sos/staff/${created.body.id}`)
      .set(asTenant(tenantA))
      .send({ compensationType: "flat_fee" })
      .expect(400);

    const updated = await agent
      .patch(`/api/sos/staff/${created.body.id}`)
      .set(asTenant(tenantA))
      .send({ compensationType: "flat_fee", amount: 800, cadence: "monthly" })
      .expect(200);
    expect(updated.body.compensationType).toBe("flat_fee");
    expect(updated.body.amount).toBe(800);
    expect(updated.body.cadence).toBe("monthly");
    expect(updated.body.commissionPercent).toBeNull();

    // Cross-tenant update must 404
    await agent
      .patch(`/api/sos/staff/${created.body.id}`)
      .set(asTenant(tenantB))
      .send({ isActive: false })
      .expect(404);
  });
});

describe("checkout attribution & earnings summary", () => {
  // Walks a fresh visit for the customer up to in_service so check_out is a
  // legal transition (staff validation runs after the transition guard).
  async function visitInService(customerId: number, serviceType: string) {
    const visit = await agent
      .post("/api/sos/visits")
      .set(asTenant(tenantA))
      .send({ customerId, serviceType })
      .expect(201);
    const resource = await agent
      .post("/api/sos/resources")
      .set(asTenant(tenantA))
      .send({ name: `Chair ${serviceType}`, resourceType: "chair" })
      .expect(201);
    await agent
      .post(`/api/sos/visits/${visit.body.id}/advance`)
      .set(asTenant(tenantA))
      .send({ action: "assign", resourceId: resource.body.id })
      .expect(200);
    await agent
      .post(`/api/sos/visits/${visit.body.id}/advance`)
      .set(asTenant(tenantA))
      .send({ action: "start_service" })
      .expect(200);
    return visit.body.id as number;
  }

  it("attributes a checkout to a staff member and reports commission from persisted amounts", async () => {
    const staff = await agent
      .post("/api/sos/staff")
      .set(asTenant(tenantA))
      .send({ name: `Earner ${RUN}`, compensationType: "commission", commissionPercent: 50 })
      .expect(201);

    const customer = await agent
      .post("/api/sos/customers")
      .set(asTenant(tenantA))
      .send({ name: `Client ${RUN}` })
      .expect(201);

    const visitId = await visitInService(customer.body.id, `Cut ${RUN}`);
    const done = await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant(tenantA))
      .send({ action: "check_out", paymentAmount: 120, staffId: staff.body.id })
      .expect(200);
    expect(done.body.staffId).toBe(staff.body.id);
    expect(done.body.staffName).toBe(`Earner ${RUN}`);

    // A staff member from another tenant can't be attributed.
    const foreign = await agent
      .post("/api/sos/staff")
      .set(asTenant(tenantB))
      .send({ name: `Foreign ${RUN}`, compensationType: "commission", commissionPercent: 10 })
      .expect(201);
    const v2 = await visitInService(customer.body.id, `Cut2 ${RUN}`);
    await agent
      .post(`/api/sos/visits/${v2}/advance`)
      .set(asTenant(tenantA))
      .send({ action: "check_out", paymentAmount: 10, staffId: foreign.body.id })
      .expect(404);

    // Earnings summary: commission = 50% of the persisted $120.
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const earnings = await agent
      .get(`/api/sos/staff-earnings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set(asTenant(tenantA))
      .expect(200);
    const row = earnings.body.find((r: any) => r.staffId === staff.body.id);
    expect(row).toBeTruthy();
    expect(row.attributedVisits).toBe(1);
    expect(row.attributedRevenue).toBe(120);
    expect(row.commissionEarned).toBe(60);
    expect(row.amountDue).toBeNull();
  });

  it("reports fee/rent due per cadence and rejects a deactivated staff attribution", async () => {
    const renter = await agent
      .post("/api/sos/staff")
      .set(asTenant(tenantA))
      .send({ name: `Renter ${RUN}`, compensationType: "booth_rent", amount: 200, cadence: "weekly" })
      .expect(201);

    // Two whole weeks selected → 2 rent periods due.
    const from = new Date("2026-07-05T00:00:00Z").toISOString();
    const to = new Date("2026-07-19T00:00:00Z").toISOString();
    const earnings = await agent
      .get(`/api/sos/staff-earnings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set(asTenant(tenantA))
      .expect(200);
    const row = earnings.body.find((r: any) => r.staffId === renter.body.id);
    expect(row.amountDue).toBe(400);
    expect(row.commissionEarned).toBeNull();

    // Invalid period
    await agent
      .get(`/api/sos/staff-earnings?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`)
      .set(asTenant(tenantA))
      .expect(400);

    // Deactivate, then attribution is refused with 409.
    await agent
      .patch(`/api/sos/staff/${renter.body.id}`)
      .set(asTenant(tenantA))
      .send({ isActive: false })
      .expect(200);
    const customer = await agent
      .post("/api/sos/customers")
      .set(asTenant(tenantA))
      .send({ name: `Client2 ${RUN}` })
      .expect(201);
    const visitId = await visitInService(customer.body.id, `Shave ${RUN}`);
    const refused = await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant(tenantA))
      .send({ action: "check_out", paymentAmount: 30, staffId: renter.body.id })
      .expect(409);
    expect(refused.body.message).toMatch(/deactivated/i);
  });
});
