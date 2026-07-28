import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Covers task requirements:
//  1. Sessions persist across a simulated server restart (Postgres-backed
//     session store instead of the default MemoryStore).
//  2. Login brute-force guard: repeated failures from one source get a 429
//     lockout with a clear message; success resets the counter.
//  3. Global rate limit: hammering the API yields 429 + Retry-After, while
//     /api/healthz and signature-authenticated webhooks are exempt.
//
// Both limiters are disabled under NODE_ENV=test by default (the shared-IP
// supertest suite would trip real limits constantly), so these tests
// force-enable them via the test-only configure hooks and reset afterwards.
// ---------------------------------------------------------------------------

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

type AppModule = typeof import("../../app");
type RateLimitModule = typeof import("../../middlewares/rateLimit");

async function freshModules(): Promise<{
  app: AppModule["default"];
  rl: RateLimitModule;
}> {
  vi.resetModules();
  const [{ default: app }, rl] = await Promise.all([
    import("../../app"),
    import("../../middlewares/rateLimit"),
  ]);
  return { app, rl };
}

// The session cookie is Secure when REPLIT_DEV_DOMAIN is present; with
// `trust proxy` set, this header makes express treat the request as HTTPS.
function asHttps(req: request.Test): request.Test {
  return req.set("X-Forwarded-Proto", "https");
}

function sessionCookieOf(res: request.Response): string {
  const setCookie = ([] as string[]).concat(
    (res.headers["set-cookie"] ?? []) as unknown as string[],
  );
  const cookie = setCookie.find((c) => c.startsWith("gnil.sid="));
  expect(cookie, "expected a gnil.sid session cookie").toBeDefined();
  return cookie!.split(";")[0];
}

describe("persistent sessions & abuse guards", () => {
  let rl: RateLimitModule | undefined;

  beforeEach(() => {
    expect(
      ADMIN_PASSWORD,
      "ADMIN_PASSWORD must be set for these tests",
    ).toBeTruthy();
  });

  afterEach(() => {
    rl?.__resetRateLimitsForTests();
  });

  it("keeps a login session valid across a simulated server restart", async () => {
    const first = await freshModules();

    const loginRes = await asHttps(
      request(first.app).post("/api/auth/login"),
    ).send({ password: ADMIN_PASSWORD });
    expect(loginRes.status).toBe(200);
    const cookie = sessionCookieOf(loginRes);

    // Sanity: the session works on the instance that created it.
    const meBefore = await asHttps(
      request(first.app).get("/api/auth/me"),
    ).set("Cookie", cookie);
    expect(meBefore.status).toBe(200);

    // "Restart": a completely fresh module graph — new express app, new
    // session middleware, new store instance. Only the database survives.
    const second = await freshModules();
    const meAfter = await asHttps(
      request(second.app).get("/api/auth/me"),
    ).set("Cookie", cookie);
    expect(meAfter.status).toBe(200);
    expect(meAfter.body).toMatchObject({ authenticated: true });

    // Logout still works on the new instance and invalidates the session.
    const logout = await asHttps(
      request(second.app).post("/api/auth/logout"),
    ).set("Cookie", cookie);
    expect(logout.status).toBe(200);
    const meLoggedOut = await asHttps(
      request(second.app).get("/api/auth/me"),
    ).set("Cookie", cookie);
    expect(meLoggedOut.status).toBe(401);
  });

  it("locks out repeated failed logins with a clear try-again-later message", async () => {
    const mods = await freshModules();
    rl = mods.rl;
    rl.__configureLoginGuardForTests({ enabled: true, maxFailures: 3 });

    for (let i = 0; i < 3; i++) {
      const res = await asHttps(
        request(mods.app).post("/api/auth/login"),
      ).send({ password: "definitely-wrong" });
      expect(res.status).toBe(401);
    }

    // 4th attempt is blocked — even with the CORRECT password.
    const blocked = await asHttps(
      request(mods.app).post("/api/auth/login"),
    ).send({ password: ADMIN_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.body.error).toBe("Too many failed login attempts");
    expect(blocked.body.message).toMatch(/try again/i);
  });

  it("resets the failure counter on successful login", async () => {
    const mods = await freshModules();
    rl = mods.rl;
    rl.__configureLoginGuardForTests({ enabled: true, maxFailures: 3 });

    // Two failures (below the limit), then a success.
    for (let i = 0; i < 2; i++) {
      const res = await asHttps(
        request(mods.app).post("/api/auth/login"),
      ).send({ password: "wrong" });
      expect(res.status).toBe(401);
    }
    const ok = await asHttps(
      request(mods.app).post("/api/auth/login"),
    ).send({ password: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);

    // Counter was reset: two more failures are still allowed (not locked).
    for (let i = 0; i < 2; i++) {
      const res = await asHttps(
        request(mods.app).post("/api/auth/login"),
      ).send({ password: "wrong" });
      expect(res.status).toBe(401);
    }
  });

  it("throttles hammering with 429 + retry hint, but never health or webhooks", async () => {
    const mods = await freshModules();
    rl = mods.rl;
    rl.__configureGlobalRateLimitForTests({ enabled: true, max: 5 });

    // Exhaust the window.
    for (let i = 0; i < 5; i++) {
      const res = await request(mods.app).get("/api/modules");
      expect(res.status).not.toBe(429);
    }
    const throttled = await request(mods.app).get("/api/modules");
    expect(throttled.status).toBe(429);
    expect(throttled.headers["retry-after"]).toBeDefined();
    expect(throttled.body).toMatchObject({ error: "Too many requests" });
    expect(throttled.body.message).toMatch(/try again/i);
    expect(throttled.body.retryAfterSeconds).toBeGreaterThan(0);

    // Health check is exempt even while the source is throttled.
    const health = await request(mods.app).get("/api/healthz");
    expect(health.status).toBe(200);

    // Vendor-signed webhooks bypass the limiter (mounted before it):
    // missing signature is a 400 from the webhook handler, never a 429.
    const webhook = await request(mods.app)
      .post("/api/stripe/webhook")
      .set("Content-Type", "application/json")
      .send("{}");
    expect(webhook.status).toBe(400);
    expect(webhook.body.error).toBe("Missing stripe-signature");
  });

  it("keeps limiters disabled by default under NODE_ENV=test", async () => {
    const mods = await freshModules();
    // Well beyond the real global default — none of these may be throttled.
    for (let i = 0; i < 20; i++) {
      const res = await request(mods.app).get("/api/healthz");
      expect(res.status).toBe(200);
    }
    const bad = await asHttps(
      request(mods.app).post("/api/auth/login"),
    ).send({ password: "wrong" });
    expect(bad.status).toBe(401);
  });
});
