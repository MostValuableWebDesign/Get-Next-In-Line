import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import app from "../app";
import {
  __configureWebhookRateLimitForTests,
  __resetRateLimitsForTests,
} from "../middlewares/rateLimit";

/**
 * Webhook flood protection: the raw-body webhook mounts (Stripe, partner
 * POS) bypass the global rate limiter, so they carry their own cheap per-IP
 * throttle that fires BEFORE signature verification. A flood of unsigned
 * junk gets 429s instead of exhausting the server on crypto work; under the
 * ceiling, requests still reach the normal handler (which rejects unsigned
 * payloads with its own 4xx).
 */

describe("webhook flood throttle", () => {
  afterEach(() => {
    __resetRateLimitsForTests();
  });

  it("429s a Stripe webhook flood before signature verification", async () => {
    __configureWebhookRateLimitForTests({ enabled: true, max: 2 });

    // Under the ceiling: reaches the handler, which rejects the unsigned
    // payload itself (400 missing stripe-signature) — not throttled.
    const first = await request(app).post("/api/stripe/webhook").send({});
    const second = await request(app).post("/api/stripe/webhook").send({});
    expect(first.status).toBe(400);
    expect(second.status).toBe(400);

    // Over the ceiling: throttled with 429 + Retry-After.
    const third = await request(app).post("/api/stripe/webhook").send({});
    expect(third.status).toBe(429);
    expect(third.headers["retry-after"]).toBeDefined();
  });

  it("shares the throttle across webhook endpoints for the same source", async () => {
    __configureWebhookRateLimitForTests({ enabled: true, max: 2 });

    await request(app).post("/api/stripe/webhook").send({});
    await request(app).post("/api/v1/partners/square/webhook").send({});
    const third = await request(app).post("/api/v1/partners/square/webhook").send({});
    expect(third.status).toBe(429);
  });

  it("is disabled by default under NODE_ENV=test", async () => {
    const res = await request(app).post("/api/stripe/webhook").send({});
    expect(res.status).toBe(400); // handler's own missing-signature rejection
  });
});
