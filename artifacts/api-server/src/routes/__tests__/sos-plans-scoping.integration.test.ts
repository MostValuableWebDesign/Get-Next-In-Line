import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosPlansTable,
  sosCustomerPlansTable,
  sosPlanTransactionsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Tenant scoping for the membership plan catalog and enrollment endpoints:
// plans (list/create/update), selling a plan to a customer, and per-customer
// plan reads. With an `x-tenant-id` header only that tenant's rows are
// visible; without it only legacy (NULL-tenant) rows are.
//
// Isolation: two throwaway tenants per run (tenant rows cascade on delete);
// the one legacy plan this suite creates is deleted explicitly with its
// dependents in afterAll. Plan names are unique per run.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME; // no Twilio connector lookup
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `pscope-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantA: number;
let tenantB: number;
let planA: number;
let planB: number;
let legacyPlan: number;
let customerA: number;

const asTenant = (id: number) => ({ "x-tenant-id": String(id) });

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  // Tenant-scoped routes now require explicit tenant context; these tests
  // exercise the legacy (NULL-tenant) scope unless a request overrides it.
  agent.set("x-tenant-id", "legacy");
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `PlanScope A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `PlanScope B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  tenantA = tenants[0].id;
  tenantB = tenants[1].id;
});

afterAll(async () => {
  // Legacy plan rows don't cascade off a tenant — remove them (and any
  // dependents) explicitly, then the tenants (their rows cascade).
  const planIds = [planA, planB, legacyPlan].filter((n) => n != null);
  if (planIds.length > 0) {
    const cps = await db
      .select({ id: sosCustomerPlansTable.id })
      .from(sosCustomerPlansTable)
      .where(inArray(sosCustomerPlansTable.planId, planIds));
    const cpIds = cps.map((r) => r.id);
    if (cpIds.length > 0) {
      await db
        .delete(sosPlanTransactionsTable)
        .where(inArray(sosPlanTransactionsTable.customerPlanId, cpIds));
      await db
        .delete(sosCustomerPlansTable)
        .where(inArray(sosCustomerPlansTable.id, cpIds));
    }
    await db.delete(sosPlansTable).where(inArray(sosPlansTable.id, planIds));
  }
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantA, tenantB]));
});

describe("plan catalog is scoped per business", () => {
  it("creates plans under the calling tenant's scope (or legacy without a header)", async () => {
    const mk = (name: string) => ({
      name,
      planType: "membership" as const,
      price: 49.99,
      billingInterval: "monthly" as const,
      discountPercent: 10,
    });
    planA = (
      await agent.post("/api/sos/plans").set(asTenant(tenantA)).send(mk(`Gold A ${RUN}`)).expect(201)
    ).body.id;
    planB = (
      await agent.post("/api/sos/plans").set(asTenant(tenantB)).send(mk(`Gold B ${RUN}`)).expect(201)
    ).body.id;
    legacyPlan = (
      await agent.post("/api/sos/plans").send(mk(`Gold Legacy ${RUN}`)).expect(201)
    ).body.id;
  });

  it("lists only the selected tenant's plans", async () => {
    const forA = await agent.get("/api/sos/plans").set(asTenant(tenantA)).expect(200);
    const idsA = forA.body.map((p: { id: number }) => p.id);
    expect(idsA).toContain(planA);
    expect(idsA).not.toContain(planB);
    expect(idsA).not.toContain(legacyPlan);
  });

  it("lists only legacy plans without tenant context", async () => {
    const legacy = await agent.get("/api/sos/plans").expect(200);
    const ids = legacy.body.map((p: { id: number }) => p.id);
    expect(ids).toContain(legacyPlan);
    expect(ids).not.toContain(planA);
    expect(ids).not.toContain(planB);
  });

  it("refuses cross-tenant plan updates", async () => {
    await agent
      .patch(`/api/sos/plans/${planA}`)
      .set(asTenant(tenantB))
      .send({ isActive: false })
      .expect(404);
    // Legacy scope can't touch a tenant's plan either.
    await agent.patch(`/api/sos/plans/${planA}`).send({ isActive: false }).expect(404);
    // Same-tenant update still works.
    const ok = await agent
      .patch(`/api/sos/plans/${planA}`)
      .set(asTenant(tenantA))
      .send({ price: 59.99 })
      .expect(200);
    expect(ok.body.price).toBe(59.99);
  });
});

describe("plan selling respects tenant boundaries", () => {
  it("cannot sell another tenant's (or a legacy) plan to a tenant's customer", async () => {
    customerA = (
      await agent
        .post("/api/sos/customers")
        .set(asTenant(tenantA))
        .send({ name: `Plan Buyer ${RUN}` })
        .expect(201)
    ).body.id;

    await agent
      .post("/api/sos/customer-plans")
      .set(asTenant(tenantA))
      .send({ customerId: customerA, planId: planB })
      .expect(404);
    await agent
      .post("/api/sos/customer-plans")
      .set(asTenant(tenantA))
      .send({ customerId: customerA, planId: legacyPlan })
      .expect(404);
  });

  it("sells a same-tenant plan and scopes the customer's enrollments", async () => {
    const sold = await agent
      .post("/api/sos/customer-plans")
      .set(asTenant(tenantA))
      .send({ customerId: customerA, planId: planA })
      .expect(201);
    expect(sold.body.planId).toBe(planA);

    const plans = await agent
      .get(`/api/sos/customers/${customerA}/plans`)
      .set(asTenant(tenantA))
      .expect(200);
    expect(plans.body.plans).toHaveLength(1);

    // Other scopes can't read this customer's enrollments at all.
    await agent.get(`/api/sos/customers/${customerA}/plans`).set(asTenant(tenantB)).expect(404);
    await agent.get(`/api/sos/customers/${customerA}/plans`).expect(404);
  });
});
