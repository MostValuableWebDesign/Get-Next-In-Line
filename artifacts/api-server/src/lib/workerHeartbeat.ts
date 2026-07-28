/**
 * In-process heartbeat for the concierge background worker, read by the
 * readiness health check. The worker records a timestamp when it starts and
 * on every tick attempt (both BullMQ and in-process interval modes), so a
 * stalled worker surfaces as a stale heartbeat instead of silent inaction.
 *
 * Deliberately process-local: readiness reports on THIS instance. In BullMQ
 * mode every instance runs a worker, and in interval mode the advisory lock
 * inside runConciergeTick already dedupes actual work — a tick attempt (even
 * one that skipped because another instance held the lock) still proves the
 * scheduler is alive, which is exactly what the heartbeat measures.
 */

let lastHeartbeatAt: Date | null = null;

/** Record a worker liveness signal (worker start or tick attempt). */
export function recordConciergeHeartbeat(now: Date = new Date()): void {
  lastHeartbeatAt = now;
}

/** Last time the concierge worker signalled liveness, or null if never. */
export function getLastConciergeHeartbeat(): Date | null {
  return lastHeartbeatAt;
}

/** Worker is considered stale after 3 missed 5-minute cadences. */
export const CONCIERGE_HEARTBEAT_STALE_MS = 15 * 60 * 1000;

/** Test-only hook: force the heartbeat state (including back to null). */
export function __setConciergeHeartbeatForTests(at: Date | null): void {
  lastHeartbeatAt = at;
}
