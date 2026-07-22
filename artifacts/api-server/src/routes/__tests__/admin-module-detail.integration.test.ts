import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  modulesTable,
  tenantsTable,
  tenantModulesTable,
  tenantActivitiesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests: GET /api/admin/modules/:id against the REAL Postgres dev
// database. Verifies the connector-aware module detail combines:
//   - the hidden connector mapping (admin-only fields)
//   - tenant assignments with provisioned dates, cadence, and MRR contribution
//   - provisioning history sourced from the tenant activity log
// Also asserts tenant-facing module endpoints never leak the seeded hidden
// connector values (white-label guard regression).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // session cookies over plain HTTP in supertest

const RUN = `amd-${Date.now()}-${process.pid}`;
const SECRET_VENDOR = `SecretVendor-${RUN}`;
const SECRET_CONNECTOR = `hidden-connector-${RUN}`;
const SECRET_NOTES = `proxy-notes-${RUN}`;

let app: import("express").Express;
let moduleId: number;
let tenantAId: number;
let tenantBId: number;

beforeAll(async () => {
  app = (await import("../../app")).default;

  const [mod] = await db
    .insert(modulesTable)
    .values({
      name: `Test Module ${RUN}`,
      category: "Test Category",
      categorySlug: "test",
      description: "Integration test module",
      wholesalePrice: "100.00",
      wholesalePriceBiweekly: "55.00",
      isActive: true,
      slug: `test_module_${RUN}`,
      upstreamVendor: SECRET_VENDOR,
      hiddenConnector: SECRET_CONNECTOR,
      proxyNotes: SECRET_NOTES,
    })
    .returning({ id: modulesTable.id });
  moduleId = mod.id;

  const [a, b] = await db
    .insert(tenantsTable)
    .values([
      { brandName: `TenantA ${RUN}`, subdomain: `a-${RUN}`, status: "active" },
      { brandName: `TenantB ${RUN}`, subdomain: `b-${RUN}`, status: "suspended" },
    ])
    .returning({ id: tenantsTable.id });
  tenantAId = a.id;
  tenantBId = b.id;

  await db.insert(tenantModulesTable).values([
    { tenantId: tenantAId, moduleId, provisionedAt: new Date("2026-05-01T00:00:00.000Z") },
    {
      tenantId: tenantBId,
      moduleId,
      provisionedAt: new Date("2026-06-01T00:00:00.000Z"),
      billingCadence: "biweekly",
    },
  ]);

  await db.insert(tenantActivitiesTable).values([
    {
      tenantId: tenantAId,
      action: "Modules provisioned",
      details: `1 module(s) activated — Test Module ${RUN}`,
      timestamp: new Date("2026-05-01T00:00:00.000Z"),
    },
    {
      tenantId: tenantAId,
      action: "Modules provisioned",
      details: "1 module(s) activated — Some Unrelated Module",
      timestamp: new Date("2026-05-02T00:00:00.000Z"),
    },
  ]);
});

afterAll(async () => {
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantAId, tenantBId]));
  await db.delete(modulesTable).where(eq(modulesTable.id, moduleId));
});

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describe("GET /api/admin/modules/:id", () => {
  it("returns 401 without a session and leaks nothing", async () => {
    const res = await request(app).get(`/api/admin/modules/${moduleId}`);
    expect(res.status).toBe(401);
    const raw = JSON.stringify(res.body);
    for (const secret of [SECRET_VENDOR, SECRET_CONNECTOR, SECRET_NOTES]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("returns 404 for unknown or non-integer module ids", async () => {
    const agent = await loggedInAgent();
    expect((await agent.get("/api/admin/modules/999999999")).status).toBe(404);
    expect((await agent.get("/api/admin/modules/abc")).status).toBe(404);
  });

  it("combines mapping, tenant assignments, and provisioning activity", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get(`/api/admin/modules/${moduleId}`);
    expect(res.status).toBe(200);

    // Mapping (hidden connector fields present for admin)
    expect(res.body.mapping).toMatchObject({
      id: moduleId,
      name: `Test Module ${RUN}`,
      slug: `test_module_${RUN}`,
      upstreamVendor: SECRET_VENDOR,
      hiddenConnector: SECRET_CONNECTOR,
      proxyNotes: SECRET_NOTES,
    });
    expect(res.body.wholesalePrice).toBe(100);
    expect(typeof res.body.resalePrice).toBe("number");
    expect(res.body.resalePrice).toBeGreaterThanOrEqual(100);

    // Tenant assignments with provisioned dates, cadence, MRR contribution
    expect(res.body.tenants).toHaveLength(2);
    const tenantA = res.body.tenants.find(
      (t: { tenantId: number }) => t.tenantId === tenantAId,
    );
    expect(tenantA).toMatchObject({
      brandName: `TenantA ${RUN}`,
      subdomain: `a-${RUN}`,
      status: "active",
      cadence: "monthly",
      mrrContribution: res.body.resalePrice,
    });
    expect(tenantA.provisionedAt).toBe("2026-05-01T00:00:00.000Z");

    // Mixed cadences on the same module: cadence and MRR come from each
    // tenant's stored billing_cadence, not module-level biweekly support.
    const tenantB = res.body.tenants.find(
      (t: { tenantId: number }) => t.tenantId === tenantBId,
    );
    const round2 = (n: number) => Math.round(n * 100) / 100;
    expect(tenantB).toMatchObject({
      cadence: "biweekly",
      mrrContribution: round2((res.body.resalePriceBiweekly * 26) / 12),
    });

    // Provisioning activity: includes only entries mentioning this module
    const details = res.body.activity.map((a: { details: string | null }) => a.details);
    expect(details.some((d: string) => d.includes(`Test Module ${RUN}`))).toBe(true);
    expect(details.every((d: string) => d.includes(`Test Module ${RUN}`))).toBe(true);
    expect(res.body.activity[0].tenantName).toBe(`TenantA ${RUN}`);
  });
});

describe("white-label guard: tenant-facing routes never leak the seeded connector", () => {
  const HIDDEN_FIELDS = ["slug", "upstreamVendor", "hiddenConnector", "proxyNotes"];

  it.each([
    ["/api/modules"],
    ["/api/modules/pricing"],
  ])("%s strips connector fields and secret values", async (path) => {
    const agent = await loggedInAgent();
    const res = await agent.get(path);
    expect(res.status).toBe(200);
    for (const item of res.body) {
      for (const field of HIDDEN_FIELDS) expect(item).not.toHaveProperty(field);
    }
    const raw = JSON.stringify(res.body);
    for (const secret of [SECRET_VENDOR, SECRET_CONNECTOR, SECRET_NOTES]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("GET /api/modules/:id/tenants exposes no connector fields or values", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get(`/api/modules/${moduleId}/tenants`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    for (const item of res.body) {
      for (const field of HIDDEN_FIELDS) expect(item).not.toHaveProperty(field);
    }
    const raw = JSON.stringify(res.body);
    for (const secret of [SECRET_VENDOR, SECRET_CONNECTOR, SECRET_NOTES]) {
      expect(raw).not.toContain(secret);
    }
  });
});
