import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// BullMQ scheduler mode: the job processor must run the same sweep sequence
// as the interval tick — in particular the delivery-status reconciliation
// backstop added for connector-proxy Twilio mode. bullmq is mocked (no Redis
// in tests) to capture the processor and invoke it directly.
// ---------------------------------------------------------------------------

const reconcileDeliveryStatuses = vi.fn(async () => 0);
vi.mock("../../lib/deliveryStatusSweep", () => ({
  reconcileDeliveryStatuses,
  verifyDeliveryStatusBySid: vi.fn(async () => undefined),
}));

// Keep the rest of the sweep sequence inert — this test only asserts wiring.
vi.mock("../../lib/concierge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/concierge")>();
  return { ...actual, reapStalePendingMessages: vi.fn(async () => 0) };
});

let capturedProcessor: ((job: { name: string }) => Promise<unknown>) | null = null;

vi.mock("bullmq", () => ({
  Queue: class {
    async upsertJobScheduler() {}
    async close() {}
  },
  Worker: class {
    constructor(_name: string, processor: (job: { name: string }) => Promise<unknown>) {
      capturedProcessor = processor;
    }
    on() {}
    async close() {}
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("concierge worker (BullMQ mode)", () => {
  it("runs the delivery-status reconciliation sweep on every job", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379/15");
    const { startConciergeWorker, JOB_SEND_REMINDER } = await import("../concierge");
    const handle = await startConciergeWorker();
    expect(handle.mode).toBe("bullmq");
    expect(capturedProcessor).toBeTruthy();

    await capturedProcessor!({ name: JOB_SEND_REMINDER });
    expect(reconcileDeliveryStatuses).toHaveBeenCalled();
    await handle.stop();
  });
});
