import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Readiness health check: /api/healthz stays a trivial liveness probe (always
// 200), while /api/healthz/ready verifies real dependencies — a DB ping and
// the concierge worker heartbeat — and returns 503 when a check fails.
// The DB is mocked so the "database down" case is deterministic.
// ---------------------------------------------------------------------------

const poolQuery = vi.fn();

vi.mock("@workspace/db", () => {
  return {
    pool: { query: poolQuery },
    db: {},
  };
});

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;

let app: import("express").Express;
let heartbeat: typeof import("../../lib/workerHeartbeat");

beforeAll(async () => {
  app = (await import("../../app")).default;
  heartbeat = await import("../../lib/workerHeartbeat");
});

beforeEach(() => {
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });
  heartbeat.__setConciergeHeartbeatForTests(new Date());
});

describe("liveness (/api/healthz)", () => {
  it("stays a trivial 200 even when the DB is down", async () => {
    poolQuery.mockRejectedValue(new Error("connection refused"));
    heartbeat.__setConciergeHeartbeatForTests(null);
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("readiness (/api/healthz/ready)", () => {
  it("returns 200 ok when DB responds and the worker heartbeat is fresh", async () => {
    const res = await request(app).get("/api/healthz/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks.database.status).toBe("ok");
    expect(res.body.checks.worker.status).toBe("ok");
    expect(res.body.checks.worker.lastHeartbeatAt).toBeTruthy();
    expect(poolQuery).toHaveBeenCalledWith("SELECT 1");
  });

  it("returns 503 unhealthy when the DB ping fails", async () => {
    poolQuery.mockRejectedValue(new Error("connection refused"));
    const res = await request(app).get("/api/healthz/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.checks.database.status).toBe("failed");
    expect(res.body.checks.database.detail).toMatch(/connection refused/);
    // Worker was fine — only the DB is reported as the failure.
    expect(res.body.checks.worker.status).toBe("ok");
  });

  it("returns 503 degraded when the worker heartbeat is stale", async () => {
    const stale = new Date(
      Date.now() - heartbeat.CONCIERGE_HEARTBEAT_STALE_MS - 60_000,
    );
    heartbeat.__setConciergeHeartbeatForTests(stale);
    const res = await request(app).get("/api/healthz/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.checks.database.status).toBe("ok");
    expect(res.body.checks.worker.status).toBe("stale");
    expect(res.body.checks.worker.lastHeartbeatAt).toBe(stale.toISOString());
  });

  it("does not fail readiness while a young process's worker has not ticked yet", async () => {
    // Fresh process (vitest run is well under the stale threshold): no
    // heartbeat yet reports "not_started" without flipping readiness.
    heartbeat.__setConciergeHeartbeatForTests(null);
    const res = await request(app).get("/api/healthz/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks.worker.status).toBe("not_started");
    expect(res.body.checks.worker.lastHeartbeatAt).toBeNull();
  });
});
