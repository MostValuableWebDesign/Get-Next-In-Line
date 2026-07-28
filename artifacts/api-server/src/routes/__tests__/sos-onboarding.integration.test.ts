import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// First-run onboarding checklist (GET /api/sos/onboarding): step completion
// is derived from the tenant's existing data — services, active staff, and
// whether open/close hours were ever saved (hoursConfirmedAt stamp).
//
// Isolation: one throwaway tenant per run (rows cascade on tenant delete);
// the legacy/global settings record is never mutated.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `onboard-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantId: number;

const asTenant = () => ({ "x-tenant-id": String(tenantId) });

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  agent.set("x-tenant-id", "legacy");
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [t] = await db
    .insert(tenantsTable)
    .values({ brandName: `Onboard ${RUN}`, subdomain: `${RUN}-a`, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = t.id;
});

afterAll(async () => {
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantId]));
});

describe("GET /api/sos/onboarding", () => {
  it("rejects requests with malformed tenant context", async () => {
    await agent.get("/api/sos/onboarding").set({ "x-tenant-id": "not-a-tenant" }).expect(400);
  });

  it("reports nothing done for a brand-new tenant", async () => {
    const res = await agent.get("/api/sos/onboarding").set(asTenant()).expect(200);
    expect(res.body).toEqual({
      addServiceDone: false,
      addStaffDone: false,
      confirmHoursDone: false,
      complete: false,
    });
  });

  it("checks off the service step once a service exists", async () => {
    await agent
      .post("/api/sos/services")
      .set(asTenant())
      .send({ name: `Trim ${RUN}` })
      .expect(201);
    const res = await agent.get("/api/sos/onboarding").set(asTenant()).expect(200);
    expect(res.body.addServiceDone).toBe(true);
    expect(res.body.complete).toBe(false);
  });

  it("checks off the staff step only for active staff", async () => {
    const created = await agent
      .post("/api/sos/staff")
      .set(asTenant())
      .send({ name: `Sam ${RUN}`, compensationType: "commission", commissionPercent: 40 })
      .expect(201);
    let res = await agent.get("/api/sos/onboarding").set(asTenant()).expect(200);
    expect(res.body.addStaffDone).toBe(true);

    // Deactivating the only staff member un-checks the step.
    await agent
      .patch(`/api/sos/staff/${created.body.id}`)
      .set(asTenant())
      .send({ isActive: false })
      .expect(200);
    res = await agent.get("/api/sos/onboarding").set(asTenant()).expect(200);
    expect(res.body.addStaffDone).toBe(false);

    await agent
      .patch(`/api/sos/staff/${created.body.id}`)
      .set(asTenant())
      .send({ isActive: true })
      .expect(200);
  });

  it("checks off hours when open/close hours are saved, completing the list", async () => {
    // Saving unrelated settings does NOT confirm hours.
    await agent
      .patch(`/api/tenants/${tenantId}/settings`)
      .send({ resourceLabel: "Chair" })
      .expect(200);
    let res = await agent.get("/api/sos/onboarding").set(asTenant()).expect(200);
    expect(res.body.confirmHoursDone).toBe(false);

    // Saving hours (even unchanged defaults) confirms them.
    await agent
      .patch(`/api/tenants/${tenantId}/settings`)
      .send({ openTime: "09:00", closeTime: "18:00" })
      .expect(200);
    res = await agent.get("/api/sos/onboarding").set(asTenant()).expect(200);
    expect(res.body).toEqual({
      addServiceDone: true,
      addStaffDone: true,
      confirmHoursDone: true,
      complete: true,
    });
  });

  it("also stamps hours via the tenant-scoped PATCH /api/sos/settings path", async () => {
    const [t] = await db
      .insert(tenantsTable)
      .values({ brandName: `Onboard2 ${RUN}`, subdomain: `${RUN}-b`, status: "active" })
      .returning({ id: tenantsTable.id });
    try {
      await agent
        .patch("/api/sos/settings")
        .set({ "x-tenant-id": String(t.id) })
        .send({ openTime: "08:00" })
        .expect(200);
      const res = await agent
        .get("/api/sos/onboarding")
        .set({ "x-tenant-id": String(t.id) })
        .expect(200);
      expect(res.body.confirmHoursDone).toBe(true);
    } finally {
      await db.delete(tenantsTable).where(inArray(tenantsTable.id, [t.id]));
    }
  });
});
