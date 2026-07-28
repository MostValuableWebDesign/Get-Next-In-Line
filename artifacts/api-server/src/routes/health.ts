import { Router, type IRouter } from "express";
import { HealthCheckResponse, ReadinessCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import {
  getLastConciergeHeartbeat,
  CONCIERGE_HEARTBEAT_STALE_MS,
} from "../lib/workerHeartbeat";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Liveness ─────────────────────────────────────────────────────────────────
// Deliberately trivial: always 200 while the process can serve requests.
// Deploy-platform probes point here, so a brief DB blip never gets a healthy
// process restarted. Dependency checks live on /healthz/ready below.
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

interface CheckResult {
  status: "ok" | "failed" | "stale" | "not_started";
  detail: string | null;
}

/** Cheap DB ping. Never throws — a failure is the result. */
async function checkDatabase(): Promise<CheckResult> {
  if (!pool) {
    return { status: "failed", detail: "database pool is not initialized" };
  }
  try {
    await pool.query("SELECT 1");
    return { status: "ok", detail: null };
  } catch (err) {
    return {
      status: "failed",
      detail: err instanceof Error ? err.message : "database ping failed",
    };
  }
}

/**
 * Worker heartbeat check. Fails when a heartbeat exists but is older than
 * the stale threshold, or when the worker never started even though the
 * process has been up long past the threshold. A young process with no
 * heartbeat yet reports "not_started" without failing readiness, so boots
 * don't flap while the worker is still spinning up.
 */
function checkWorker(now: Date = new Date()): CheckResult {
  const last = getLastConciergeHeartbeat();
  if (!last) {
    const uptimeMs = process.uptime() * 1000;
    if (uptimeMs > CONCIERGE_HEARTBEAT_STALE_MS) {
      return {
        status: "stale",
        detail: `concierge worker never started (process up ${Math.round(uptimeMs / 1000)}s)`,
      };
    }
    return { status: "not_started", detail: "concierge worker has not ticked yet" };
  }
  const ageMs = now.getTime() - last.getTime();
  if (ageMs > CONCIERGE_HEARTBEAT_STALE_MS) {
    return {
      status: "stale",
      detail: `last concierge heartbeat ${Math.round(ageMs / 1000)}s ago`,
    };
  }
  return { status: "ok", detail: null };
}

// ── Readiness ────────────────────────────────────────────────────────────────
// Verifies real dependencies: DB connectivity + concierge worker heartbeat.
// 200 only when everything passes; 503 with per-check details otherwise
// ("unhealthy" when the DB is down, "degraded" when only the worker stalled).
router.get("/healthz/ready", async (_req, res) => {
  const [database, worker] = [await checkDatabase(), checkWorker()];

  const status =
    database.status === "failed"
      ? "unhealthy"
      : worker.status === "stale"
        ? "degraded"
        : "ok";

  const body = ReadinessCheckResponse.parse({
    status,
    checks: {
      database: { status: database.status, detail: database.detail },
      worker: {
        status: worker.status,
        detail: worker.detail,
        lastHeartbeatAt: getLastConciergeHeartbeat()?.toISOString() ?? null,
      },
    },
  });
  if (status !== "ok") {
    logger.warn({ readiness: body }, "Readiness check not ok");
  }
  res.status(status === "ok" ? 200 : 503).json(body);
});

export default router;
