import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mock @workspace/db so tests run without a real database.
// 25 fake activity rows across two tenants let us verify:
//   - no query param  → global feed capped at the default page size (20)
//   - ?tenantId=N     → only tenant N's rows, paginated with limit/offset
//   - ?tenantId=abc   → 400 (zod coercion fails)
// The mock replays the query chain the route builds
// (.where() → .limit() → .offset()), so a silent regression in the branch
// (e.g. dropping the where clause or the bounds) fails these tests.
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
  // Tenant 2's rows intentionally share ONE timestamp so ordering must fall
  // back to the id-desc tiebreak (stable ordering across pages).
  ...Array.from({ length: 3 }, (_, i) => ({
    id: 100 + i,
    tenantId: 2,
    tenantName: "Globex",
    action: `Globex action ${i + 1}`,
    details: "detail",
    timestamp: new Date(Date.UTC(2026, 1, 1, 0, 0)),
  })),
];

// Captures the columns the route passes to .orderBy() so a regression that
// drops the id tiebreak (or the timestamp sort) fails loudly.
let capturedOrderBy: unknown[] = [];

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

  // Query chain that mimics drizzle's builder for the activity route:
  // .where(cond?) → .orderBy(...) → .limit(n) (awaitable), with an optional
  // trailing .offset(m) for the legacy offset path.
  type Cond =
    | { rhs: number } // eq() mock
    | { and: Cond[] } // and() mock
    | { cursor: { ts: Date; id: number } } // sql`` keyset mock
    | undefined;

  function applyConditions(cond: Cond, rows: typeof fakeActivities) {
    if (!cond) return rows;
    const conds = "and" in cond ? cond.and : [cond];
    let out = rows;
    for (const c of conds) {
      if (c && "rhs" in c) out = out.filter((r) => r.tenantId === c.rhs);
      if (c && "cursor" in c) {
        const { ts, id } = c.cursor;
        out = out.filter(
          (r) =>
            r.timestamp.getTime() < ts.getTime() ||
            (r.timestamp.getTime() === ts.getTime() && r.id < id),
        );
      }
    }
    return out;
  }

  function makeActivityQuery() {
    const sorted = [...fakeActivities].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime() || b.id - a.id,
    );
    return {
      where: (cond: Cond) => {
        const rows = applyConditions(cond, sorted);
        return {
          orderBy: (...cols: unknown[]) => {
            capturedOrderBy = cols;
            return {
              // Awaiting .limit(n) directly serves the keyset path; the
              // legacy offset path chains .offset(m) afterwards.
              limit: (n: number) =>
                Object.assign(Promise.resolve(rows.slice(0, n)), {
                  offset: (m: number) => Promise.resolve(rows.slice(m, m + n)),
                }),
            };
          },
        };
      },
    };
  }

  const existingTenantIds = new Set([1, 2]);

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        leftJoin: () => makeActivityQuery(),
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
// desc() tags the column so we can assert the route sorts descending.
vi.mock("drizzle-orm", () => ({
  eq: (_lhs: unknown, rhs: unknown) => ({ rhs }),
  desc: (col: unknown) => ({ dir: "desc", col }),
  and: (...conds: unknown[]) => ({ and: conds }),
  // route: sql`(${tsCol}, ${idCol}) < (${beforeTimestamp}, ${beforeId})`
  // → values are [tsCol, idCol, beforeTimestamp, beforeId]
  sql: (_strings: TemplateStringsArray, ...vals: unknown[]) => ({
    cursor: { ts: vals[2] as Date, id: vals[3] as number },
  }),
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
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(20);
    expect(res.body.hasMore).toBe(true); // 25 total rows > 20
    // Global feed: newest first, so Globex (Feb) rows lead, then Acme (Jan)
    expect(res.body.items[0].tenantName).toBe("Globex");
    const tenantIds = new Set(res.body.items.map((r: { tenantId: number }) => r.tenantId));
    expect(tenantIds).toEqual(new Set([1, 2]));
  });

  it("with ?tenantId returns ONLY that tenant's events, paginated with hasMore", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/tenants/activity?tenantId=1");
    expect(res.status).toBe(200);
    // Tenant 1 has 22 rows — first page is bounded at the default 20
    expect(res.body.items).toHaveLength(20);
    expect(res.body.hasMore).toBe(true);
    for (const item of res.body.items) {
      expect(item.tenantId).toBe(1);
      expect(item.tenantName).toBe(TENANT_NAMES[1]);
    }
    // The next page returns the remaining 2 rows and hasMore=false
    const page2 = await agent.get("/api/tenants/activity?tenantId=1&limit=20&offset=20");
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(2);
    expect(page2.body.hasMore).toBe(false);
    for (const item of page2.body.items) {
      expect(item.tenantId).toBe(1);
    }
    // No overlap between pages
    const ids1 = res.body.items.map((r: { id: number }) => r.id);
    const ids2 = page2.body.items.map((r: { id: number }) => r.id);
    expect(ids1.filter((id: number) => ids2.includes(id))).toHaveLength(0);
  });

  it("with ?tenantId for another tenant returns only that tenant's events", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/tenants/activity?tenantId=2");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.hasMore).toBe(false);
    for (const item of res.body.items) {
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

  it("respects a custom limit and rejects limits above the 100 cap", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/tenants/activity?tenantId=1&limit=5");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.hasMore).toBe(true);

    const tooBig = await agent.get("/api/tenants/activity?limit=500");
    expect(tooBig.status).toBe(400);
    expect(tooBig.body).toHaveProperty("error");
  });

  it("supports a custom offset within a page (no off-by-one at page edges)", async () => {
    const agent = await loggedInAgent();
    // Tenant 1 has 22 rows, all distinct timestamps: ids 22..1 in desc order.
    const res = await agent.get("/api/tenants/activity?tenantId=1&limit=5&offset=5");
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { id: number }) => r.id)).toEqual([17, 16, 15, 14, 13]);
    expect(res.body.hasMore).toBe(true);
  });

  it("hasMore is false when limit lands exactly on the last row, true one short of it", async () => {
    const agent = await loggedInAgent();
    // Tenant 2 has exactly 3 rows: limit=3 → exact boundary, no more pages.
    const exact = await agent.get("/api/tenants/activity?tenantId=2&limit=3");
    expect(exact.status).toBe(200);
    expect(exact.body.items).toHaveLength(3);
    expect(exact.body.hasMore).toBe(false);

    // limit=2 → one row remains.
    const short = await agent.get("/api/tenants/activity?tenantId=2&limit=2");
    expect(short.body.items).toHaveLength(2);
    expect(short.body.hasMore).toBe(true);

    // offset+limit == total is also an exact boundary.
    const lastPage = await agent.get("/api/tenants/activity?tenantId=2&limit=2&offset=1");
    expect(lastPage.body.items).toHaveLength(2);
    expect(lastPage.body.hasMore).toBe(false);

    // offset past the end → empty page, hasMore false.
    const beyond = await agent.get("/api/tenants/activity?tenantId=2&limit=2&offset=3");
    expect(beyond.body.items).toHaveLength(0);
    expect(beyond.body.hasMore).toBe(false);
  });

  it("orders by timestamp desc with id desc as tiebreak for same-timestamp events", async () => {
    const agent = await loggedInAgent();
    // Tenant 2's three rows share one timestamp — id desc must break the tie.
    const res = await agent.get("/api/tenants/activity?tenantId=2");
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { id: number }) => r.id)).toEqual([102, 101, 100]);

    // The route must request BOTH sort keys, descending, in this order.
    expect(capturedOrderBy).toEqual([
      { dir: "desc", col: "activities.timestamp" },
      { dir: "desc", col: "activities.id" },
    ]);
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
