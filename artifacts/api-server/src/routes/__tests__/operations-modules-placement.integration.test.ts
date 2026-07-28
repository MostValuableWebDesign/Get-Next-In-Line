import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, modulesTable, tenantsTable, tenantModulesTable, tenantActivitiesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { CONNECTOR_MAPPING } from "../../lib/connectorSeed";

// ---------------------------------------------------------------------------
// Core Operations marketplace lock — the five advanced service modules must:
//   1. stay seeded/stored with categorySlug "operations" (Core Operations grid)
//   2. list under operations via the tenant-facing modules API
//   3. price as wholesale × (1 + markup%) with correct margin
//   4. provision through checkout with the right MRR delta (monthly), and
//      reject bi-weekly cadence when the module offers no bi-weekly rate
// Runs against the REAL Postgres dev database (like the other .integration
// tests in this directory).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // session cookies over plain HTTP in supertest

const OPERATIONS_MODULES = [
  "Commission & Split Tracker",
  "Complete Payroll & Tax Suite",
  "No-Show Shield & Deposits",
  "Service Payroll Hub",
  "Smart Booking System",
] as const;

const DAILY_WORKFLOW_SLUGS = ["bookings", "calendar", "pos", "marketing"]; // never valid module categories

const RUN = `ops-lock-${Date.now()}-${process.pid}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

let app: import("express").Express;
let tenantId: number;

beforeAll(async () => {
  app = (await import("../../app")).default;
  const [t] = await db
    .insert(tenantsTable)
    .values({ brandName: `OpsLock Tenant ${RUN}`, subdomain: `ops-${RUN}`, status: "active", mrr: "0" })
    .returning({ id: tenantsTable.id });
  tenantId = t.id;
});

afterAll(async () => {
  await db.delete(tenantActivitiesTable).where(eq(tenantActivitiesTable.tenantId, tenantId));
  await db.delete(tenantModulesTable).where(eq(tenantModulesTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describe("seed guard: connector mapping pins the five service modules to operations", () => {
  it.each(OPERATIONS_MODULES)('"%s" is seeded with categorySlug "operations"', (name) => {
    const entry = CONNECTOR_MAPPING.find((e) => e.name === name);
    expect(entry, `${name} missing from CONNECTOR_MAPPING — fresh databases would lose it`).toBeDefined();
    expect(entry!.categorySlug).toBe("operations");
  });

  it("no seed entry uses a daily-workflow slug as a module category", () => {
    // "marketing" is no longer a valid module category either — the former
    // Marketing OS modules were folded into "media" (White-Label Resale Engines).
    for (const entry of CONNECTOR_MAPPING) {
      expect(DAILY_WORKFLOW_SLUGS).not.toContain(entry.categorySlug);
    }
  });
});

describe("modules API: placement under Core Operations", () => {
  it("lists all five service modules with categorySlug operations", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/modules");
    expect(res.status).toBe(200);

    for (const name of OPERATIONS_MODULES) {
      const mod = res.body.find((m: { name: string }) => m.name === name);
      expect(mod, `${name} missing from /api/modules`).toBeDefined();
      expect(mod.categorySlug, `${name} re-categorized out of operations`).toBe("operations");
      expect(mod.wholesalePrice).toBeGreaterThan(0);
    }
  });
});

describe("pricing API: wholesale × markup math for operations modules", () => {
  it("resalePrice and margin derive exactly from wholesale × (1 + markup%)", async () => {
    const agent = await loggedInAgent();
    const [modulesRes, pricingRes] = await Promise.all([
      agent.get("/api/modules"),
      agent.get("/api/modules/pricing"),
    ]);
    expect(pricingRes.status).toBe(200);

    for (const name of OPERATIONS_MODULES) {
      const mod = modulesRes.body.find((m: { name: string }) => m.name === name);
      const price = pricingRes.body.find((p: { id: number }) => p.id === mod.id);
      expect(price, `${name} missing from /api/modules/pricing`).toBeDefined();
      expect(price.wholesalePrice).toBe(mod.wholesalePrice);
      const expectedResale = round2(price.wholesalePrice * (1 + price.markupPercent / 100));
      expect(price.resalePrice, `${name} resale price drifted from wholesale × markup`).toBe(expectedResale);
      expect(price.margin).toBe(round2(price.resalePrice - price.wholesalePrice));
    }
  });
});

describe("checkout: provisioning an operations module", () => {
  it("provisions monthly, records the assignment, and applies the exact MRR delta", async () => {
    const agent = await loggedInAgent();
    const modules = (await agent.get("/api/modules")).body;
    const pricing = (await agent.get("/api/modules/pricing")).body;
    const smartBooking = modules.find((m: { name: string }) => m.name === "Smart Booking System");
    const price = pricing.find((p: { id: number }) => p.id === smartBooking.id);

    const [before] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    const mrrBefore = parseFloat(before.mrr ?? "0");

    const res = await agent.post("/api/billing/checkout").send({
      tenantId,
      moduleIds: [smartBooking.id],
      applyMarkup: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.modulesProvisioned).toBe(1);
    expect(res.body.totalResale).toBe(price.resalePrice);
    expect(res.body.margin).toBe(round2(price.resalePrice - price.wholesalePrice));

    // Assignment recorded with monthly cadence
    const assignments = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.tenantId, tenantId));
    expect(assignments).toHaveLength(1);
    expect(assignments[0].moduleId).toBe(smartBooking.id);
    expect(assignments[0].billingCadence).toBe("monthly");

    // Tenant MRR moved by exactly the resale price
    const [after] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    expect(round2(parseFloat(after.mrr ?? "0") - mrrBefore)).toBe(price.resalePrice);
    expect(after.modulesEnabled).toBe(1);
  });

  it("rejects bi-weekly cadence for operations modules without a bi-weekly rate", async () => {
    const agent = await loggedInAgent();
    const modules = (await agent.get("/api/modules")).body;
    const noShow = modules.find((m: { name: string }) => m.name === "No-Show Shield & Deposits");

    const res = await agent.post("/api/billing/checkout").send({
      tenantId,
      moduleIds: [noShow.id],
      applyMarkup: true,
      moduleCadences: [{ moduleId: noShow.id, cadence: "biweekly" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("does not offer bi-weekly billing");

    // Nothing provisioned, MRR untouched by the failed attempt
    const assignments = await db
      .select()
      .from(tenantModulesTable)
      .where(inArray(tenantModulesTable.moduleId, [noShow.id]))
      .then((rows) => rows.filter((r) => r.tenantId === tenantId));
    expect(assignments).toHaveLength(0);
  });

  it("applies the ×26/12 monthly-equivalent MRR delta for a bi-weekly-capable module", async () => {
    const agent = await loggedInAgent();
    // Create a throwaway module with a distinct bi-weekly rate so the cadence
    // math is exercised without touching real catalog data.
    const [mod] = await db
      .insert(modulesTable)
      .values({
        name: `BiWeekly Test ${RUN}`,
        category: "Test",
        categorySlug: "test",
        description: "bi-weekly cadence test",
        wholesalePrice: "100.00",
        wholesalePriceBiweekly: "55.00",
        isActive: true,
      })
      .returning();

    try {
      const pricing = (await agent.get("/api/modules/pricing")).body;
      const price = pricing.find((p: { id: number }) => p.id === mod.id);
      expect(price.resalePriceBiweekly).toBe(round2(55 * (1 + price.markupPercent / 100)));

      const [before] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
      const mrrBefore = parseFloat(before.mrr ?? "0");

      const res = await agent.post("/api/billing/checkout").send({
        tenantId,
        moduleIds: [mod.id],
        applyMarkup: true,
        moduleCadences: [{ moduleId: mod.id, cadence: "biweekly" }],
      });
      expect(res.status).toBe(200);
      expect(res.body.totalResale).toBe(price.resalePriceBiweekly);

      const [after] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
      // Bi-weekly recurs 26×/year → MRR delta is resale × 26/12 (rounded on write)
      expect(round2(parseFloat(after.mrr ?? "0") - mrrBefore)).toBe(
        round2(round2(price.resalePriceBiweekly * (26 / 12)) )
      );
    } finally {
      await db.delete(tenantModulesTable).where(eq(tenantModulesTable.moduleId, mod.id));
      await db.delete(modulesTable).where(eq(modulesTable.id, mod.id));
    }
  });
});
