import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, tenantActivitiesTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests: GET /api/tenants/activity against the REAL Postgres dev
// database (no mocks). This exercises the actual Drizzle SQL — ordering
// (timestamp desc, id desc tiebreak), keyset cursor paging, and hasMore
// boundaries — which the mock-based suite can only simulate.
//
// Isolation strategy:
//   - Two throwaway tenants are inserted with unique subdomains per run.
//   - All assertions use ?tenantId=<seeded id>, so pre-existing rows in the
//     dev database can never leak into the results.
//   - afterAll deletes the tenants; tenant_activities has ON DELETE CASCADE,
//     so the seeded activity rows are removed too. Runs are repeatable.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // session cookies over plain HTTP in supertest

const RUN = `it-${Date.now()}-${process.pid}`;

let app: import("express").Express;

let alphaId: number; // 7 rows: 5 distinct timestamps + first 3 rows share one timestamp
let betaId: number; // 3 rows, all sharing a single timestamp
const seededTenantIds: number[] = [];

// Expected activity ids in API order (timestamp desc, id desc) per tenant.
let alphaExpectedIds: number[] = [];
let betaExpectedIds: number[] = [];

beforeAll(async () => {
  app = (await import("../../app")).default;

  const [alpha, beta] = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Alpha ${RUN}`, subdomain: `alpha-${RUN}`, status: "active" },
      { brandName: `Beta ${RUN}`, subdomain: `beta-${RUN}`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  alphaId = alpha.id;
  betaId = beta.id;
  seededTenantIds.push(alphaId, betaId);

  // Alpha: 3 rows at an identical timestamp (tiebreak territory), then 4 rows
  // at strictly increasing later timestamps. Insert the tied rows first so
  // their serial ids are ascending while their timestamps are equal.
  const tied = new Date("2026-03-01T10:00:00.000Z");
  const alphaRows = await db
    .insert(tenantActivitiesTable)
    .values([
      { tenantId: alphaId, action: `${RUN} alpha tied 1`, timestamp: tied },
      { tenantId: alphaId, action: `${RUN} alpha tied 2`, timestamp: tied },
      { tenantId: alphaId, action: `${RUN} alpha tied 3`, timestamp: tied },
      { tenantId: alphaId, action: `${RUN} alpha later 1`, timestamp: new Date("2026-03-02T10:00:00.000Z") },
      { tenantId: alphaId, action: `${RUN} alpha later 2`, timestamp: new Date("2026-03-03T10:00:00.000Z") },
      { tenantId: alphaId, action: `${RUN} alpha later 3`, timestamp: new Date("2026-03-04T10:00:00.000Z") },
      { tenantId: alphaId, action: `${RUN} alpha later 4`, timestamp: new Date("2026-03-05T10:00:00.000Z") },
    ])
    .returning({ id: tenantActivitiesTable.id, timestamp: tenantActivitiesTable.timestamp });

  // Beta: 3 rows all at one timestamp — pure id-desc ordering.
  const betaTs = new Date("2026-04-01T09:30:00.000Z");
  const betaRows = await db
    .insert(tenantActivitiesTable)
    .values([
      { tenantId: betaId, action: `${RUN} beta 1`, timestamp: betaTs },
      { tenantId: betaId, action: `${RUN} beta 2`, timestamp: betaTs },
      { tenantId: betaId, action: `${RUN} beta 3`, timestamp: betaTs },
    ])
    .returning({ id: tenantActivitiesTable.id });

  const byApiOrder = (
    a: { id: number; timestamp: Date },
    b: { id: number; timestamp: Date },
  ) => b.timestamp.getTime() - a.timestamp.getTime() || b.id - a.id;
  alphaExpectedIds = [...alphaRows].sort(byApiOrder).map((r) => r.id);
  betaExpectedIds = [...betaRows].map((r) => r.id).sort((a, b) => b - a);
});

afterAll(async () => {
  if (seededTenantIds.length) {
    // ON DELETE CASCADE removes the seeded activity rows too.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, seededTenantIds));
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

describe("GET /api/tenants/activity (real database)", () => {
  it("orders by timestamp desc with id desc tiebreak in real SQL", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get(`/api/tenants/activity?tenantId=${alphaId}&limit=100`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { id: number }) => r.id)).toEqual(alphaExpectedIds);
    expect(res.body.hasMore).toBe(false);
    // Timestamps must be non-increasing.
    const times = res.body.items.map((r: { timestamp: string }) => Date.parse(r.timestamp));
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    // The 3 same-timestamp rows are the last 3 and are in id-desc order.
    const tail = res.body.items.slice(-3);
    expect(tail.map((r: { id: number }) => r.id)).toEqual(
      [...tail.map((r: { id: number }) => r.id)].sort((a, b) => b - a),
    );
    expect(new Set(tail.map((r: { timestamp: string }) => r.timestamp)).size).toBe(1);
  });

  it("orders same-timestamp rows purely by id desc", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get(`/api/tenants/activity?tenantId=${betaId}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { id: number }) => r.id)).toEqual(betaExpectedIds);
    expect(res.body.hasMore).toBe(false);
  });

  it("pages with keyset cursor (before_timestamp/before_id): no overlap, no gaps, stable across ties", async () => {
    const agent = await loggedInAgent();
    const pages: { id: number; timestamp: string }[][] = [];
    let cursor: { before_timestamp: string; before_id: number } | null = null;
    // Walk the whole alpha feed 3 rows at a time using the cursor.
    for (let i = 0; i < 10; i++) {
      const qs =
        `tenantId=${alphaId}&limit=3` +
        (cursor
          ? `&before_timestamp=${encodeURIComponent(cursor.before_timestamp)}&before_id=${cursor.before_id}`
          : "");
      const res = await agent.get(`/api/tenants/activity?${qs}`);
      expect(res.status).toBe(200);
      pages.push(res.body.items);
      if (!res.body.hasMore) break;
      const last = res.body.items[res.body.items.length - 1];
      cursor = { before_timestamp: last.timestamp, before_id: last.id };
    }
    const stitched = pages.flat().map((r) => r.id);
    // Cursor-stitched pages reproduce the full ordered result exactly,
    // including deterministic paging through the tied-timestamp rows.
    expect(stitched).toEqual(alphaExpectedIds);
    expect(new Set(stitched).size).toBe(stitched.length);
  });

  it("rejects a cursor half (before_timestamp without before_id, and vice versa)", async () => {
    const agent = await loggedInAgent();
    const noId = await agent.get(
      `/api/tenants/activity?before_timestamp=${encodeURIComponent(new Date().toISOString())}`,
    );
    expect(noId.status).toBe(400);
    const noTs = await agent.get(`/api/tenants/activity?before_id=1`);
    expect(noTs.status).toBe(400);
  });

  it("hasMore boundaries: exact fit false, one-short true, past-the-end empty", async () => {
    const agent = await loggedInAgent();
    // Beta has exactly 3 rows.
    const exact = await agent.get(`/api/tenants/activity?tenantId=${betaId}&limit=3`);
    expect(exact.body.items).toHaveLength(3);
    expect(exact.body.hasMore).toBe(false);

    const short = await agent.get(`/api/tenants/activity?tenantId=${betaId}&limit=2`);
    expect(short.body.items).toHaveLength(2);
    expect(short.body.hasMore).toBe(true);

    // Cursor page containing exactly the final row → exact boundary, no more.
    const last = short.body.items[short.body.items.length - 1];
    const lastPage = await agent.get(
      `/api/tenants/activity?tenantId=${betaId}&limit=2&before_timestamp=${encodeURIComponent(last.timestamp)}&before_id=${last.id}`,
    );
    expect(lastPage.body.items).toHaveLength(1);
    expect(lastPage.body.hasMore).toBe(false);

    // Cursor past the end → empty page, hasMore false.
    const oldest = betaExpectedIds[betaExpectedIds.length - 1];
    const beyond = await agent.get(
      `/api/tenants/activity?tenantId=${betaId}&limit=2&before_timestamp=${encodeURIComponent(last.timestamp)}&before_id=${oldest}`,
    );
    expect(beyond.body.items).toHaveLength(0);
    expect(beyond.body.hasMore).toBe(false);
  });

  it("filters strictly to the requested tenant and joins the tenant name", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get(`/api/tenants/activity?tenantId=${alphaId}&limit=100`);
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.tenantId).toBe(alphaId);
      expect(item.tenantName).toBe(`Alpha ${RUN}`);
      expect(item.action).toContain(RUN);
    }
  });

  it("global feed includes the seeded rows in correct relative order", async () => {
    const agent = await loggedInAgent();
    // The global feed contains unrelated dev rows; assert only the relative
    // order of our seeded rows within it.
    const res = await agent.get(`/api/tenants/activity?limit=100`);
    expect(res.status).toBe(200);
    const mineExpected = [...betaExpectedIds, ...alphaExpectedIds]; // beta (Apr) newer than alpha (Mar)
    const mine = res.body.items
      .map((r: { id: number }) => r.id)
      .filter((id: number) => mineExpected.includes(id));
    // Only assert if all seeded rows fit in the first 100 global rows.
    if (mine.length === mineExpected.length) {
      expect(mine).toEqual(mineExpected);
    } else {
      // Whatever subset appears must still be in the expected relative order.
      const rank = new Map(mineExpected.map((id, i) => [id, i]));
      const ranks = mine.map((id: number) => rank.get(id)!);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
  });

  it("returns 404 for a tenant id that does not exist in the database", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get(`/api/tenants/activity?tenantId=999999999`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Tenant not found" });
  });
});
