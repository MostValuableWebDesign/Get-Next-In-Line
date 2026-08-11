import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { CONNECTOR_MAPPING } from "../../lib/connectorSeed";

// ---------------------------------------------------------------------------
// White-label contract guard: partnerBrand on the tenant-facing /api/modules
// response is a deliberate, NARROW exception — it must be populated only for
// categorySlug "partners" (partner modules are presented by brand on purpose)
// and null for every other category. A refactor that starts exposing upstream
// vendor identity for white-labeled marketing/media modules must fail here.
// Runs against the REAL Postgres dev database (like other .integration tests).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // session cookies over plain HTTP in supertest

let app: import("express").Express;

beforeAll(async () => {
  app = (await import("../../app")).default;
});

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

const SEEDED_PARTNERS = CONNECTOR_MAPPING.filter((e) => e.categorySlug === "partners");

describe("partnerBrand exposure is scoped to the partners category", () => {
  it("the seed defines exactly five active partner modules, all with a partnerBrand", () => {
    // The standalone 401(k)/benefits offering was consolidated into Gusto, and
    // the Deel and The Hartford offerings were retired.
    expect(SEEDED_PARTNERS).toHaveLength(5);
    for (const entry of SEEDED_PARTNERS) {
      expect(entry.partnerBrand, `${entry.name} seeded without partnerBrand`).toBeTruthy();
    }
    // And no non-partners seed entry carries a partner brand
    for (const entry of CONNECTOR_MAPPING) {
      if (entry.categorySlug !== "partners") {
        expect(entry.partnerBrand, `${entry.name} (${entry.categorySlug}) must not have partnerBrand`).toBeUndefined();
      }
    }
  });

  it("GET /api/modules: partnerBrand populated for all active partner modules, null everywhere else", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/modules");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    const partnerModules = res.body.filter(
      (m: { categorySlug: string }) => m.categorySlug === "partners"
    );
    expect(partnerModules.length).toBeGreaterThanOrEqual(5);

    // Every seeded partner module appears with its brand exposed
    for (const entry of SEEDED_PARTNERS) {
      const mod = res.body.find((m: { name: string }) => m.name === entry.name);
      expect(mod, `partner module "${entry.name}" missing from /api/modules`).toBeDefined();
      expect(mod.categorySlug).toBe("partners");
      expect(mod.partnerBrand, `"${entry.name}" lost its partner brand`).toBe(entry.partnerBrand);
    }

    // Every partners-category module in the response has a non-null brand
    for (const mod of partnerModules) {
      expect(
        mod.partnerBrand,
        `partners module "${mod.name}" returned null partnerBrand`
      ).toEqual(expect.any(String));
      expect(mod.partnerBrand.length).toBeGreaterThan(0);
    }

    // Every non-partners module must be fully white-labeled: partnerBrand null
    for (const mod of res.body) {
      if (mod.categorySlug !== "partners") {
        expect(
          mod.partnerBrand,
          `white-label leak: "${mod.name}" (${mod.categorySlug}) exposed partnerBrand "${mod.partnerBrand}"`
        ).toBeNull();
      }
    }
  });
});
