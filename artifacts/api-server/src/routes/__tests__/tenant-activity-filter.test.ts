import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mock @workspace/db so tests run without a real database.
// 25 fake activity rows across two tenants let us verify:
//   - no query param  → global feed capped at 20 (limit applied)
//   - ?tenantId=N     → only tenant N's rows, with NO limit (full history)
//   - ?tenantId=abc   → 400 (zod coercion fails)
// The mock replays the query chain the route builds and records whether
// .where()/.limit() were applied, so a silent regression in the branch
// (e.g. dropping the where clause) fails these tests.
// ---------------------------------------------------------------------------

const TENANT_NAMES: Record<number, string> = { 1: "Acme", 2: "Globex" };

// 22 rows for tenant 1 + 3 rows for tenant 2 = 25 total (more than the 20 cap)
const fakeActivities = [
  ...Array.from({ length: 22 }, (_, i) => ({
    id: i + 1,
    tenantId: 1,
    tenantName: "Acme",
    action: `Acme action ${i + 1}`,
    details: null,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)),
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    id: 100 + i,
    tenantId: 2,
    tenantName: "Globex",
    action: `Globex action ${i + 1}`,
    details: "detail",
    timestamp: new Date(Date.UTC(2026, 1, 1, 0, i)),
  })),
];

vi.mock("@workspace/db", () => {
  const tenantsTable = { id: "tenants.id", brandName: "tenants.brandName" };
  const tenantActivitiesTable = {
    id: "activities.id",
    tenantId: "activities.tenantId",
    action: "activities.action",
    details: "activities.details",
    timestamp: "activities.timestamp",
  };
  const tenantModulesTable = {};
  const modulesTable = { categorySlug: "categorySlug", name: "name" };
  const agencySettingsTable = {};

  // Query chain that mimics drizzle's builder for the activity route.
  function makeActivityQuery() {
    const sorted = [...fakeActivities].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );
    return {
      // route: .where(eq(tenantActivitiesTable.tenantId, tenantId))
      where: (cond: { rhs?: unknown } | unknown) => {
        // our eq() mock returns { rhs }
        const tenantId = (cond as { rhs: number }).rhs;
        return Promise.resolve(sorted.filter((r) => r.tenantId === tenantId));
      },
      // route: .limit(20)
      limit: (n: number) => Promise.resolve(sorted.slice(0, n)),
    };
  }

  const existingTenantIds = new Set([1, 2]);

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        leftJoin: () => ({
          orderBy: () => makeActivityQuery(),
        }),
        orderBy: () => Promise.resolve([]),
        limit: () => Promise.resolve([]),
        // route: tenant-existence check .where(eq(tenantsTable.id, tenantId))
        where: (cond: { rhs?: unknown } | unknown) => {
          if (table === tenantsTable) {
            const id = (cond as { rhs: number }).rhs;
            return Promise.resolve(existingTenantIds.has(id) ? [{ id }] : []);
          }
          return Promise.resolve([]);
        },
      }),
    }),
  };
  return { db, tenantsTable, tenantActivitiesTable, tenantModulesTable, modulesTable, agencySettingsTable };
});

// Mock drizzle-orm's eq so the .where() mock above can read the tenantId value.
vi.mock("drizzle-orm", () => ({
  eq: (_lhs: unknown, rhs: unknown) => ({ rhs }),
  desc: (col: unknown) => col,
}));

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // so session cookies work over plain HTTP in supertest

let app: import("express").Express;

beforeAll(async () => {
  app = (await import("../../app")).default;
});

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describe("GET /api/tenants/activity", () => {
  it("with no query param returns the latest 20 global events", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/tenants/activity");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(20);
    // Global feed: newest first, so Globex (Feb) rows lead, then Acme (Jan)
    expect(res.body[0].tenantName).toBe("Globex");
    const tenantIds = new Set(res.body.map((r: { tenantId: number }) => r.tenantId));
    expect(tenantIds).toEqual(new Set([1, 2]));
  });

  it("with ?tenantId returns ONLY that tenant's events, with no 20-row cap", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/tenants/activity?tenantId=1");
    expect(res.status).toBe(200);
    // Tenant 1 has 22 rows — more than the global cap — all must be returned
    expect(res.body).toHaveLength(22);
    for (const item of res.body) {
      expect(item.tenantId).toBe(1);
      expect(item.tenantName).toBe(TENANT_NAMES[1]);
    }
  });

  it("with ?tenantId for another tenant returns only that tenant's events", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/tenants/activity?tenantId=2");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    for (const item of res.body) {
      expect(item.tenantId).toBe(2);
      expect(item.tenantName).toBe(TENANT_NAMES[2]);
    }
  });

  it("with a tenantId that does not exist returns 404, not an empty list", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/tenants/activity?tenantId=999");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Tenant not found" });
  });

  it("with a non-numeric tenantId returns 400", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/tenants/activity?tenantId=abc");
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("requires an authenticated session", async () => {
    const res = await request(app).get("/api/tenants/activity");
    expect(res.status).toBe(401);
  });
});
