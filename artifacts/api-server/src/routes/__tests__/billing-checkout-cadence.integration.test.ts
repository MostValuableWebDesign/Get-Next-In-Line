import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  modulesTable,
  tenantModulesTable,
  tenantActivitiesTable,
  agencySettingsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests: POST /api/billing/checkout with moduleCadences against
// the REAL Postgres dev database.
//
// Guards the bi-weekly pricing contract:
//   - bi-weekly modules bill at wholesalePriceBiweekly, not wholesalePrice
//   - tenant MRR delta uses the ×26/12 monthly-equivalent conversion
//   - tenant_modules.billing_cadence records the chosen cadence
//   - activity log notes the per-module cadence
//   - bi-weekly is rejected for modules without a bi-weekly rate, and for
//     modules not part of the checkout
//
// Isolation: throwaway tenants + modules with unique per-run names; afterAll
// deletes them (tenant_modules / tenant_activities cascade on tenant delete).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // session cookies over plain HTTP in supertest

const RUN = `bwck-${Date.now()}-${process.pid}`;
const BIWEEKLY_TO_MONTHLY = 26 / 12;

let app: import("express").Express;
let markupPercent: number;

const seededTenantIds: number[] = [];
const seededModuleIds: number[] = [];

// Module fixtures: bi-weekly rate is deliberately NOT wholesale/2 so a bug
// that bills the monthly price under a biweekly cadence changes the totals.
let biModA: { id: number; name: string }; // monthly 100.00, biweekly 55.00
let biModB: { id: number; name: string }; // monthly 80.00, biweekly 44.40
let monthlyOnlyMod: { id: number; name: string }; // monthly 60.00, no biweekly rate

async function newTenant(label: string): Promise<{ id: number; mrr: number }> {
  const [t] = await db
    .insert(tenantsTable)
    .values({
      brandName: `${label} ${RUN}`,
      subdomain: `${label.toLowerCase()}-${RUN}`,
      status: "active",
      mrr: "250.00",
    })
    .returning({ id: tenantsTable.id, mrr: tenantsTable.mrr });
  seededTenantIds.push(t.id);
  return { id: t.id, mrr: parseFloat(t.mrr ?? "0") };
}

beforeAll(async () => {
  app = (await import("../../app")).default;

  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  markupPercent = parseFloat(settings?.markupPercent ?? "25");

  const mods = await db
    .insert(modulesTable)
    .values([
      {
        name: `BiModA ${RUN}`,
        category: "Test",
        categorySlug: "test",
        description: "bi-weekly capable module A",
        wholesalePrice: "100.00",
        wholesalePriceBiweekly: "55.00",
        slug: `bimod-a-${RUN}`,
      },
      {
        name: `BiModB ${RUN}`,
        category: "Test",
        categorySlug: "test",
        description: "bi-weekly capable module B",
        wholesalePrice: "80.00",
        wholesalePriceBiweekly: "44.40",
        slug: `bimod-b-${RUN}`,
      },
      {
        name: `MonthlyOnly ${RUN}`,
        category: "Test",
        categorySlug: "test",
        description: "monthly-only module",
        wholesalePrice: "60.00",
        slug: `monthly-only-${RUN}`,
      },
    ])
    .returning({ id: modulesTable.id, name: modulesTable.name });
  [biModA, biModB, monthlyOnlyMod] = mods;
  seededModuleIds.push(...mods.map((m) => m.id));
});

afterAll(async () => {
  if (seededTenantIds.length) {
    // Cascades remove tenant_modules and tenant_activities rows.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, seededTenantIds));
  }
  if (seededModuleIds.length) {
    await db.delete(modulesTable).where(inArray(modulesTable.id, seededModuleIds));
  }
});

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

describe("POST /api/billing/checkout with moduleCadences (real database)", () => {
  it("happy path: mixed monthly + bi-weekly checkout prices, provisions, and converts MRR at ×26/12", async () => {
    const agent = await loggedInAgent();
    const tenant = await newTenant("Happy");

    // biModA on bi-weekly cadence, biModB defaults to monthly (no entry),
    // monthlyOnlyMod explicitly monthly.
    const res = await agent.post("/api/billing/checkout").send({
      tenantId: tenant.id,
      moduleIds: [biModA.id, biModB.id, monthlyOnlyMod.id],
      moduleCadences: [
        { moduleId: biModA.id, cadence: "biweekly" },
        { moduleId: monthlyOnlyMod.id, cadence: "monthly" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.modulesProvisioned).toBe(3);
    expect(res.body.modulesSkipped).toBe(0);

    // Totals: biModA billed at its BI-WEEKLY rate (55), not monthly (100).
    const expectedWholesale = round2(55 + 80 + 60);
    const markupFactor = 1 + markupPercent / 100;
    const expectedResale = round2((55 + 80 + 60) * markupFactor);
    expect(res.body.totalWholesale).toBeCloseTo(expectedWholesale, 2);
    expect(res.body.totalResale).toBeCloseTo(expectedResale, 2);
    expect(res.body.margin).toBeCloseTo(round2(expectedResale - expectedWholesale), 2);

    // MRR delta: bi-weekly resale converted ×26/12; monthly resale as-is.
    const expectedMrrDelta =
      55 * markupFactor * BIWEEKLY_TO_MONTHLY + (80 + 60) * markupFactor;
    const [after] = await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenant.id));
    expect(parseFloat(after.mrr ?? "0")).toBeCloseTo(
      round2(tenant.mrr + expectedMrrDelta),
      2
    );
    expect(after.modulesEnabled).toBe(3);

    // tenant_modules.billing_cadence records the chosen cadence per module.
    const assignments = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.tenantId, tenant.id));
    const cadenceByModule = new Map(assignments.map((a) => [a.moduleId, a.billingCadence]));
    expect(cadenceByModule.get(biModA.id)).toBe("biweekly");
    expect(cadenceByModule.get(biModB.id)).toBe("monthly"); // default when omitted
    expect(cadenceByModule.get(monthlyOnlyMod.id)).toBe("monthly");

    // Activity log notes the per-module cadence.
    const activities = await db
      .select()
      .from(tenantActivitiesTable)
      .where(eq(tenantActivitiesTable.tenantId, tenant.id));
    expect(activities).toHaveLength(1);
    expect(activities[0].action).toBe("Modules provisioned");
    expect(activities[0].details).toContain(`${biModA.name} (bi-weekly)`);
    expect(activities[0].details).toContain(`${biModB.name} (monthly)`);
    expect(activities[0].details).toContain(`${monthlyOnlyMod.name} (monthly)`);
  });

  it("rejects a bi-weekly cadence for a module that is not part of the checkout", async () => {
    const agent = await loggedInAgent();
    const tenant = await newTenant("NotInCart");
    const before = tenant.mrr;

    const res = await agent.post("/api/billing/checkout").send({
      tenantId: tenant.id,
      moduleIds: [biModB.id],
      moduleCadences: [{ moduleId: biModA.id, cadence: "biweekly" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(`module ${biModA.id}`);
    expect(res.body.error).toContain("not in this checkout");

    // Nothing was provisioned, nothing changed.
    const assignments = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.tenantId, tenant.id));
    expect(assignments).toHaveLength(0);
    const [after] = await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenant.id));
    expect(parseFloat(after.mrr ?? "0")).toBe(before);
  });

  it("rejects a bi-weekly cadence for a module without a bi-weekly rate, leaving no partial state", async () => {
    const agent = await loggedInAgent();
    const tenant = await newTenant("NoRate");
    const before = tenant.mrr;

    const res = await agent.post("/api/billing/checkout").send({
      tenantId: tenant.id,
      moduleIds: [monthlyOnlyMod.id, biModA.id],
      moduleCadences: [
        { moduleId: monthlyOnlyMod.id, cadence: "biweekly" },
        { moduleId: biModA.id, cadence: "biweekly" },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`${monthlyOnlyMod.name} does not offer bi-weekly billing`);

    // The whole checkout is rejected — even the valid bi-weekly module is not provisioned.
    const assignments = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.tenantId, tenant.id));
    expect(assignments).toHaveLength(0);
    const [after] = await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenant.id));
    expect(parseFloat(after.mrr ?? "0")).toBe(before);
    const activities = await db
      .select()
      .from(tenantActivitiesTable)
      .where(eq(tenantActivitiesTable.tenantId, tenant.id));
    expect(activities).toHaveLength(0);
  });

  it("rejects an unknown cadence value at the schema layer", async () => {
    const agent = await loggedInAgent();
    const tenant = await newTenant("BadEnum");
    const res = await agent.post("/api/billing/checkout").send({
      tenantId: tenant.id,
      moduleIds: [biModA.id],
      moduleCadences: [{ moduleId: biModA.id, cadence: "weekly" }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a tenant that does not exist", async () => {
    const agent = await loggedInAgent();
    const res = await agent.post("/api/billing/checkout").send({
      tenantId: 999999999,
      moduleIds: [biModA.id],
      moduleCadences: [{ moduleId: biModA.id, cadence: "biweekly" }],
    });
    expect(res.status).toBe(404);
  });

  it("charges the monthly rate and records monthly cadence when moduleCadences is omitted entirely", async () => {
    const agent = await loggedInAgent();
    const tenant = await newTenant("Default");

    const res = await agent.post("/api/billing/checkout").send({
      tenantId: tenant.id,
      moduleIds: [biModA.id],
      applyMarkup: false,
    });
    expect(res.status).toBe(200);
    // Monthly wholesale price, no markup — exact numbers.
    expect(res.body.totalWholesale).toBe(100);
    expect(res.body.totalResale).toBe(100);

    const [after] = await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenant.id));
    // MRR delta is the plain monthly amount — no ×26/12 conversion.
    expect(parseFloat(after.mrr ?? "0")).toBeCloseTo(round2(tenant.mrr + 100), 2);

    const assignments = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.tenantId, tenant.id));
    expect(assignments).toHaveLength(1);
    expect(assignments[0].billingCadence).toBe("monthly");
  });
});
