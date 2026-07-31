import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, modulesTable, tenantsTable, tenantModulesTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { CONNECTOR_MAPPING, seedConnectorMapping } from "../../lib/connectorSeed";

// ---------------------------------------------------------------------------
// Pass-through billing contract for Partner-Direct Integrations:
//   - every seeded partner module carries an EXPLICIT 0% markup override AND
//     a $0.00 wholesale price — a partner module may never bill above $0
//   - the seed treats the catalog's wholesale price as authoritative for
//     partner modules on EVERY run (not just insert), so legacy rows carrying
//     pre-contract prices reconcile to $0.00 while historical charged
//     snapshots on past activations stay untouched
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
  it("all seven seeded partner modules carry an explicit 0% override and a $0.00 wholesale price", () => {
    const partners = CONNECTOR_MAPPING.filter((e) => e.categorySlug === "partners");
    // The retired 401(k)/benefits offering was consolidated into Gusto.
    expect(partners).toHaveLength(7);
    for (const entry of partners) {
      expect(
        entry.markupPercentOverride,
        `${entry.name} must have an explicit "0" markup override`
      ).toBe("0");
      expect(
        entry.wholesalePrice,
        `${entry.name} must declare a $0.00 wholesale price — partner modules never bill above $0`
      ).toBe("0.00");
      expect(
        entry.wholesalePriceBiweekly,
        `${entry.name} must not carry a bi-weekly rate — partner modules never bill above $0`
      ).toBeUndefined();
    }
  });

  it("the seed reconciles legacy partner rows to $0.00 wholesale on every run, leaving charged snapshots untouched", async () => {
    // Simulate the five oldest partner rows that still carried legacy
    // wholesale prices: stamp a pre-contract price onto a seeded partner row.
    const [gustoBefore] = await db
      .select()
      .from(modulesTable)
      .where(eq(modulesTable.slug, "gusto"));
    expect(gustoBefore).toBeDefined();
    await db
      .update(modulesTable)
      .set({ wholesalePrice: "129.00", markupPercentOverride: "25" })
      .where(eq(modulesTable.id, gustoBefore.id));

    // A historical activation whose realized charges predate the contract —
    // these snapshots must never be rewritten.
    const [snapshotAssignment] = await db
      .insert(tenantModulesTable)
      .values({
        tenantId,
        moduleId: gustoBefore.id,
        billingCadence: "monthly",
        chargedWholesale: "59.00",
        chargedResale: "59.00",
        paymentMode: "simulated",
      })
      .returning({ id: tenantModulesTable.id });

    await seedConnectorMapping();

    // The catalog's declared price is authoritative on update, not just insert.
    const [gustoAfter] = await db
      .select()
      .from(modulesTable)
      .where(eq(modulesTable.id, gustoBefore.id));
    expect(gustoAfter.wholesalePrice).toBe("0.00");
    expect(parseFloat(gustoAfter.markupPercentOverride!)).toBe(0);

    // Every seeded partners-category row now bills at $0 wholesale / 0% markup.
    const partnerSlugs = CONNECTOR_MAPPING.filter((e) => e.categorySlug === "partners").map(
      (e) => e.slug
    );
    const partnerRows = await db
      .select()
      .from(modulesTable)
      .where(inArray(modulesTable.slug, partnerSlugs));
    expect(partnerRows).toHaveLength(partnerSlugs.length);
    for (const row of partnerRows) {
      expect(row.wholesalePrice, `${row.name} must carry $0.00 wholesale`).toBe("0.00");
      expect(
        parseFloat(row.markupPercentOverride ?? "NaN"),
        `${row.name} must carry a 0% markup override`
      ).toBe(0);
      expect(row.wholesalePriceBiweekly, `${row.name} must not carry a bi-weekly rate`).toBeNull();
    }

    // Historical charged snapshots are untouched by the reconciliation.
    const [snapshotAfter] = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.id, snapshotAssignment.id));
    expect(snapshotAfter.chargedWholesale).toBe("59.00");
    expect(snapshotAfter.chargedResale).toBe("59.00");
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
      .where(
        and(
          eq(tenantModulesTable.tenantId, tenantId),
          eq(tenantModulesTable.moduleId, rogueModuleId)
        )
      );
    expect(parseFloat(assignment.chargedWholesale!)).toBe(80);
    expect(parseFloat(assignment.chargedResale!)).toBe(80);
  });
});
