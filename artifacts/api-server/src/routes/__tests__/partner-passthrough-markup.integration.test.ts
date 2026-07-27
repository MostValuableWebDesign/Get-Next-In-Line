import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, modulesTable, tenantsTable, tenantModulesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CONNECTOR_MAPPING } from "../../lib/connectorSeed";

// ---------------------------------------------------------------------------
// Pass-through billing contract for Partner-Direct Integrations:
//   - every seeded partner module carries an EXPLICIT 0% markup override
//   - anything in the partners category bills at multiplier 1.00 across
//     pricing and checkout, even if a bogus override sneaks into the DB.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;

const RUN = `ppt-${Date.now()}-${process.pid}`;

let app: import("express").Express;
let rogueModuleId: number;
let tenantId: number;

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

beforeAll(async () => {
  app = (await import("../../app")).default;
  // A partners-category module whose stored override is WRONG (25%) and whose
  // wholesale price is non-zero — the category-level enforcement must still
  // bill it at exactly wholesale.
  const [mod] = await db
    .insert(modulesTable)
    .values({
      name: `Rogue Partner ${RUN}`,
      category: "Partner-Direct Integrations",
      categorySlug: "partners",
      description: "partner module with a bogus markup override",
      wholesalePrice: "80.00",
      isActive: true,
      partnerBrand: `RogueBrand ${RUN}`,
      markupPercentOverride: "25",
    })
    .returning({ id: modulesTable.id });
  rogueModuleId = mod.id;

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `PPT Tenant ${RUN}`, subdomain: `${RUN}-t` })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;
});

afterAll(async () => {
  await db.delete(tenantModulesTable).where(eq(tenantModulesTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  await db.delete(modulesTable).where(eq(modulesTable.id, rogueModuleId));
});

describe("partner-direct pass-through markup (multiplier 1.00)", () => {
  it("all eight seeded partner modules carry an explicit 0% override", () => {
    const partners = CONNECTOR_MAPPING.filter((e) => e.categorySlug === "partners");
    expect(partners).toHaveLength(8);
    for (const entry of partners) {
      expect(
        entry.markupPercentOverride,
        `${entry.name} must have an explicit "0" markup override`
      ).toBe("0");
    }
  });

  it("GET /api/modules/pricing bills the partners category at wholesale, ignoring bogus overrides", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/modules/pricing");
    expect(res.status).toBe(200);
    const rogue = res.body.find((p: { id: number }) => p.id === rogueModuleId);
    expect(rogue).toBeDefined();
    expect(rogue.markupPercent).toBe(0);
    expect(rogue.resalePrice).toBe(80);
    expect(rogue.margin).toBe(0);
  });

  it("checkout charges a partner module strictly at wholesale (zero margin)", async () => {
    const agent = await loggedInAgent();
    const res = await agent
      .post("/api/billing/checkout")
      .send({ tenantId, moduleIds: [rogueModuleId], applyMarkup: true });
    expect(res.status).toBe(200);
    expect(res.body.totalWholesale).toBe(80);
    expect(res.body.totalResale).toBe(80);
    expect(res.body.margin).toBe(0);

    // Realized pricing persisted at checkout is also pass-through.
    const [assignment] = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.tenantId, tenantId));
    expect(parseFloat(assignment.chargedWholesale!)).toBe(80);
    expect(parseFloat(assignment.chargedResale!)).toBe(80);
  });
});
