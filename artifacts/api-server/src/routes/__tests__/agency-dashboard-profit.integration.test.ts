import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, tenantModulesTable, tenantActivitiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Agency dashboard profit summary — /api/agency/dashboard reports
// monthlyProfit and markupEarnings from the REALIZED margin persisted at
// checkout time (charged_resale − charged_wholesale per assignment).
//
// Other integration tests run in parallel against the same database and
// mutate provisioning state, so this suite never asserts before/after deltas
// on the global aggregate. Instead it verifies:
//   1. the dashboard exposes well-formed profit fields;
//   2. checkout persists the exact realized per-charge pricing on rows this
//      test owns — the sole input to the dashboard's profit aggregation —
//      including zero realized margin for applyMarkup: false and
//      cadence-specific bi-weekly amounts.
// Runs against the REAL Postgres dev database.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // session cookies over plain HTTP in supertest

const RUN = `dash-profit-${Date.now()}-${process.pid}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

let app: import("express").Express;
const tenantIds: number[] = [];

async function freshTenant(tag: string) {
  const [t] = await db
    .insert(tenantsTable)
    .values({ brandName: `DashProfit ${tag} ${RUN}`, subdomain: `dp-${tag}-${RUN}`, status: "active", mrr: "0" })
    .returning({ id: tenantsTable.id });
  tenantIds.push(t.id);
  return t.id;
}

beforeAll(async () => {
  app = (await import("../../app")).default;
});

afterAll(async () => {
  for (const id of tenantIds) {
    await db.delete(tenantActivitiesTable).where(eq(tenantActivitiesTable.tenantId, id));
    await db.delete(tenantModulesTable).where(eq(tenantModulesTable.tenantId, id));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id));
  }
});

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

async function ownAssignment(tenantId: number) {
  const [assignment] = await db
    .select()
    .from(tenantModulesTable)
    .where(eq(tenantModulesTable.tenantId, tenantId));
  expect(assignment).toBeDefined();
  return assignment;
}

describe("agency dashboard profit summary (realized margin)", () => {
  it("exposes well-formed monthlyProfit and markupEarnings fields", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/agency/dashboard");
    expect(res.status).toBe(200);
    expect(typeof res.body.monthlyProfit).toBe("number");
    expect(typeof res.body.markupEarnings).toBe("number");
    expect(res.body.monthlyProfit).toBeGreaterThanOrEqual(0);
    expect(res.body.markupEarnings).toBeGreaterThanOrEqual(0);
    expect(res.body.monthlyProfit).toBe(res.body.markupEarnings);
  });

  it("a marked-up monthly checkout persists realized margin = resale − wholesale", async () => {
    const agent = await loggedInAgent();
    const tenantId = await freshTenant("mk");
    const modules = (await agent.get("/api/modules")).body;
    const pricing = (await agent.get("/api/modules/pricing")).body;
    const mod = modules.find((m: { name: string }) => m.name === "Smart Booking System");
    const price = pricing.find((p: { id: number }) => p.id === mod.id);

    const res = await agent
      .post("/api/billing/checkout")
      .send({ tenantId, moduleIds: [mod.id], applyMarkup: true });
    expect(res.status).toBe(200);

    const assignment = await ownAssignment(tenantId);
    expect(assignment.moduleId).toBe(mod.id);
    expect(parseFloat(assignment.chargedWholesale!)).toBe(price.wholesalePrice);
    expect(parseFloat(assignment.chargedResale!)).toBe(price.resalePrice);
    // Realized margin — the dashboard aggregation input — matches the quote.
    expect(round2(parseFloat(assignment.chargedResale!) - parseFloat(assignment.chargedWholesale!))).toBe(
      round2(price.resalePrice - price.wholesalePrice),
    );
  });

  it("a checkout with applyMarkup: false persists zero realized margin despite the assignment existing", async () => {
    const agent = await loggedInAgent();
    const tenantId = await freshTenant("nomk");
    const modules = (await agent.get("/api/modules")).body;
    const mod = modules.find((m: { name: string }) => m.name === "Commission & Split Tracker");

    const res = await agent
      .post("/api/billing/checkout")
      .send({ tenantId, moduleIds: [mod.id], applyMarkup: false });
    expect(res.status).toBe(200);
    expect(res.body.margin).toBe(0);

    const assignment = await ownAssignment(tenantId);
    expect(assignment.moduleId).toBe(mod.id);
    // Zero realized margin persisted → contributes exactly $0 to dashboard profit.
    expect(assignment.chargedResale).toBe(assignment.chargedWholesale);
  });

  it("a bi-weekly marked-up checkout persists cadence-specific charged amounts", async () => {
    const agent = await loggedInAgent();
    const tenantId = await freshTenant("bw");
    const pricing = (await agent.get("/api/modules/pricing")).body;
    const price = pricing.find(
      (p: { resalePriceBiweekly: number | null }) => p.resalePriceBiweekly != null,
    );
    expect(price, "no bi-weekly-capable module found").toBeDefined();

    const res = await agent.post("/api/billing/checkout").send({
      tenantId,
      moduleIds: [price.id],
      applyMarkup: true,
      moduleCadences: [{ moduleId: price.id, cadence: "biweekly" }],
    });
    expect(res.status).toBe(200);

    const assignment = await ownAssignment(tenantId);
    expect(assignment.billingCadence).toBe("biweekly");
    // Bi-weekly per-charge amounts persisted (the dashboard applies ×26/12).
    expect(parseFloat(assignment.chargedWholesale!)).toBe(price.wholesalePriceBiweekly);
    expect(parseFloat(assignment.chargedResale!)).toBe(price.resalePriceBiweekly);
  });
});
