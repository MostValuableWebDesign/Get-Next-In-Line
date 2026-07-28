import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { db, mrrSnapshotsTable } from "@workspace/db";
import { computeMrrGrowthPercent } from "../agency";

// ---------------------------------------------------------------------------
// Agency dashboard MRR growth — /api/agency/dashboard computes
// mrrGrowthPercent from a real historical baseline (the total-MRR snapshot
// nearest to ~30 days ago) instead of a hardcoded number, and reports null
// ("not enough data") when no baseline exists.
//
// Snapshots are a small global table; this suite owns it for its assertions
// (vitest runs api-server test files serially against the shared dev DB).
// Concurrent dashboard reads only upsert TODAY's row, which never serves as
// a baseline, so clearing + seeding old-dated rows here is race-safe.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // session cookies over plain HTTP in supertest

let app: import("express").Express;

beforeAll(async () => {
  app = (await import("../../app")).default;
});

beforeEach(async () => {
  await db.delete(mrrSnapshotsTable);
});

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

describe("computeMrrGrowthPercent (pinned)", () => {
  it("computes (current − baseline)/baseline × 100, rounded to one decimal", () => {
    expect(computeMrrGrowthPercent(1124, 1000)).toBe(12.4);
    expect(computeMrrGrowthPercent(900, 1000)).toBe(-10);
    expect(computeMrrGrowthPercent(1000, 1000)).toBe(0);
    expect(computeMrrGrowthPercent(1001, 3000)).toBe(-66.6);
  });

  it("returns null with no baseline or a zero baseline — never a fabricated number", () => {
    expect(computeMrrGrowthPercent(500, null)).toBeNull();
    expect(computeMrrGrowthPercent(500, 0)).toBeNull();
  });
});

describe("agency dashboard MRR growth (integration)", () => {
  it("fresh install (no snapshot history) reports mrrGrowthPercent: null", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/agency/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.mrrGrowthPercent).toBeNull();
    // The read itself recorded today's snapshot for future baselines…
    const snapshots = await db.select().from(mrrSnapshotsTable);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    // …but a same-day snapshot is never a baseline: a second read stays null.
    const res2 = await agent.get("/api/agency/dashboard");
    expect(res2.body.mrrGrowthPercent).toBeNull();
  });

  it("with a ≥30-day-old snapshot, growth is computed from real data", async () => {
    const agent = await loggedInAgent();
    // Seed a baseline 31 days ago plus a newer-but-still-old decoy: the most
    // recent snapshot at least 30 days old must win.
    await db.insert(mrrSnapshotsTable).values([
      { snapshotDate: daysAgo(45), totalMrr: "999999.00" },
      { snapshotDate: daysAgo(31), totalMrr: "1000.00" },
    ]);
    const res = await agent.get("/api/agency/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.mrrGrowthPercent).toBe(
      computeMrrGrowthPercent(res.body.totalMrr, 1000),
    );
    expect(res.body.mrrGrowthPercent).not.toBe(12.4 /* the old hardcoded lie */);
  });

  it("a zero-MRR baseline yields null, not Infinity", async () => {
    const agent = await loggedInAgent();
    await db.insert(mrrSnapshotsTable).values({ snapshotDate: daysAgo(31), totalMrr: "0.00" });
    const res = await agent.get("/api/agency/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.mrrGrowthPercent).toBeNull();
  });
});
