import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  clientProfilesTable,
  engagementRulesTable,
  coopComplianceLedgerTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Pagination on the previously unbounded list endpoints: tenants,
// per-tenant engagement rules, client profiles, and the co-op compliance
// ledger. Covers default page behavior, explicit limit/offset paging
// (disjoint pages, stable order), and the 400 on oversized limits.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;

const RUN = `pagination-${Date.now()}-${process.pid}`;
const YEAR = new Date().getUTCFullYear();
const PERIOD = String(YEAR);

let agent: ReturnType<typeof request.agent>;
let tenantIds: number[] = [];
let tenantId: number;

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD }).expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values(
      [0, 1, 2].map((i) => ({
        brandName: `Pagination ${i} ${RUN}`,
        subdomain: `${RUN}-${i}`,
        status: "active",
      })),
    )
    .returning({ id: tenantsTable.id });
  tenantIds = tenants.map((t) => t.id);
  tenantId = tenantIds[0];

  await db.insert(clientProfilesTable).values(
    Array.from({ length: 7 }, (_, i) => ({
      tenantId,
      name: `Client ${i} ${RUN}`,
      phone: null,
      preferredChannel: "sms",
    })),
  );

  await db.insert(engagementRulesTable).values(
    Array.from({ length: 5 }, () => ({
      tenantId,
      ruleType: "reminder",
      isActive: false,
      config: { hoursBefore: 24 },
    })),
  );

  await db.insert(coopComplianceLedgerTable).values(
    Array.from({ length: 5 }, (_, i) => ({
      tenantId,
      category: "sponsorship",
      direction: "income",
      description: `Entry ${i} ${RUN}`,
      grossAmount: "10.00",
      stateRatePercent: "0",
      localRatePercent: "0",
      salesRatePercent: "0",
      estimatedTaxAmount: "0",
      sourceRef: `manual:${RUN}-${i}`,
      occurredAt: new Date(Date.UTC(YEAR, 5, 10 + i)),
    })),
  );
});

afterAll(async () => {
  // Cascades to client_profiles, engagement_rules, coop_compliance_ledger.
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
});

describe("GET /api/tenants pagination", () => {
  it("returns exactly `limit` rows when more exist", async () => {
    const res = await agent.get("/api/tenants?limit=2").expect(200);
    expect(res.body).toHaveLength(2);
  });

  it("pages are disjoint and together contain every seeded tenant exactly once", async () => {
    const a = await agent.get("/api/tenants?limit=500&offset=0").expect(200);
    const b = await agent.get("/api/tenants?limit=500&offset=500").expect(200);
    const ids = [...a.body, ...b.body].map((t: { id: number }) => t.id);
    for (const id of tenantIds) {
      expect(ids.filter((x) => x === id)).toHaveLength(1);
    }
  });

  it("rejects an oversized limit with 400", async () => {
    await agent.get("/api/tenants?limit=501").expect(400);
    await agent.get("/api/tenants?limit=0").expect(400);
  });
});

describe("GET /api/tenants/:id/engagement-rules pagination", () => {
  it("default request returns every rule (small dataset unchanged)", async () => {
    const res = await agent.get(`/api/tenants/${tenantId}/engagement-rules`).expect(200);
    expect(res.body).toHaveLength(5);
  });

  it("explicit limit/offset pages are disjoint and ordered by id", async () => {
    const a = await agent
      .get(`/api/tenants/${tenantId}/engagement-rules?limit=3&offset=0`)
      .expect(200);
    const b = await agent
      .get(`/api/tenants/${tenantId}/engagement-rules?limit=3&offset=3`)
      .expect(200);
    expect(a.body).toHaveLength(3);
    expect(b.body).toHaveLength(2);
    const ids = [...a.body, ...b.body].map((r: { id: number }) => r.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
  });

  it("rejects an oversized limit with 400", async () => {
    await agent.get(`/api/tenants/${tenantId}/engagement-rules?limit=501`).expect(400);
  });
});

describe("GET /api/tenants/:id/client-profiles pagination", () => {
  it("default request returns every profile (small dataset unchanged)", async () => {
    const res = await agent.get(`/api/tenants/${tenantId}/client-profiles`).expect(200);
    expect(res.body).toHaveLength(7);
  });

  it("explicit limit/offset pages are disjoint, newest first", async () => {
    const a = await agent
      .get(`/api/tenants/${tenantId}/client-profiles?limit=4&offset=0`)
      .expect(200);
    const b = await agent
      .get(`/api/tenants/${tenantId}/client-profiles?limit=4&offset=4`)
      .expect(200);
    expect(a.body).toHaveLength(4);
    expect(b.body).toHaveLength(3);
    const ids = [...a.body, ...b.body].map((p: { id: number }) => p.id);
    expect(new Set(ids).size).toBe(7);
    // desc(createdAt), desc(id) — seeded in one insert, so ids descend.
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
  });

  it("rejects an oversized limit with 400", async () => {
    await agent.get(`/api/tenants/${tenantId}/client-profiles?limit=501`).expect(400);
  });
});

describe("GET /api/coop/compliance/ledger pagination", () => {
  it("default request returns every entry in the period", async () => {
    const res = await agent
      .get(`/api/coop/compliance/ledger?period=${PERIOD}`)
      .set("x-tenant-id", String(tenantId))
      .expect(200);
    expect(res.body).toHaveLength(5);
  });

  it("explicit limit/offset pages are disjoint, newest first", async () => {
    const a = await agent
      .get(`/api/coop/compliance/ledger?period=${PERIOD}&limit=2&offset=0`)
      .set("x-tenant-id", String(tenantId))
      .expect(200);
    const b = await agent
      .get(`/api/coop/compliance/ledger?period=${PERIOD}&limit=2&offset=2`)
      .set("x-tenant-id", String(tenantId))
      .expect(200);
    const c = await agent
      .get(`/api/coop/compliance/ledger?period=${PERIOD}&limit=2&offset=4`)
      .set("x-tenant-id", String(tenantId))
      .expect(200);
    expect(a.body).toHaveLength(2);
    expect(b.body).toHaveLength(2);
    expect(c.body).toHaveLength(1);
    const dates = [...a.body, ...b.body, ...c.body].map(
      (e: { occurredAt: string }) => e.occurredAt,
    );
    expect(new Set(dates).size).toBe(5);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("rejects an oversized limit with 400", async () => {
    await agent
      .get(`/api/coop/compliance/ledger?period=${PERIOD}&limit=501`)
      .set("x-tenant-id", String(tenantId))
      .expect(400);
  });
});
