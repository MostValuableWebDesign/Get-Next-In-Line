import type { Request, Response, NextFunction } from "express";

// ─────────────────────────────────────────────────────────────────────────────
// Abuse protection: global fixed-window rate limit + login brute-force guard.
//
// Both limiters follow the same in-process fixed-window pattern already used
// by the public-booking limiter (see routes/publicBooking.ts). They are
// per-process by design — good enough to stop a single source from hammering
// one server; external DDoS protection is explicitly out of scope.
//
// Test behavior: vitest sets NODE_ENV=test, and the integration suite fires
// hundreds of same-IP requests (supertest) — real limits would trip
// constantly. Under NODE_ENV=test both limiters are disabled unless a test
// explicitly force-enables them via the __configure hooks below.
// ─────────────────────────────────────────────────────────────────────────────

const isTestEnv = () => process.env.NODE_ENV === "test";

function clientKey(req: Request): string {
  // trust proxy is set, so req.ip reflects X-Forwarded-For from Replit's proxy.
  return req.ip ?? "unknown";
}

interface WindowEntry {
  windowStart: number;
  count: number;
}

/** Opportunistically drop expired entries so maps can't grow unboundedly. */
function sweep(map: Map<string, WindowEntry>, windowMs: number, now: number): void {
  if (map.size <= 10_000) return;
  for (const [key, val] of map) {
    if (now - val.windowStart >= windowMs) map.delete(key);
  }
}

// ── Global API rate limit ────────────────────────────────────────────────────
// Generous per-IP ceiling: normal staff usage (even a busy dashboard polling
// several endpoints) stays far below it; only abusive hammering trips it.

const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_DEFAULT_MAX = 600; // 600 requests / minute / IP

let globalConfig = {
  enabled: !isTestEnv(),
  windowMs: GLOBAL_WINDOW_MS,
  max: Number(process.env.GLOBAL_RATE_LIMIT_MAX) > 0
    ? Number(process.env.GLOBAL_RATE_LIMIT_MAX)
    : GLOBAL_DEFAULT_MAX,
};

const globalHits = new Map<string, WindowEntry>();

/**
 * App-wide request limiter. Mounted after the raw-body webhook routes (which
 * therefore bypass it — they are authenticated by vendor signatures and must
 * never be dropped) and skips the health check so uptime monitors are never
 * throttled.
 */
export function globalRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (!globalConfig.enabled) return next();
  if (req.path === "/api/healthz") return next();

  const now = Date.now();
  const key = clientKey(req);
  const entry = globalHits.get(key);
  if (!entry || now - entry.windowStart >= globalConfig.windowMs) {
    globalHits.set(key, { windowStart: now, count: 1 });
    sweep(globalHits, globalConfig.windowMs, now);
    return next();
  }
  entry.count++;
  if (entry.count > globalConfig.max) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((entry.windowStart + globalConfig.windowMs - now) / 1000),
    );
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: "Too many requests",
      message: `Rate limit exceeded. Try again in ${retryAfterSec} second(s).`,
      retryAfterSeconds: retryAfterSec,
    });
    return;
  }
  next();
}

// ── Webhook flood throttle ───────────────────────────────────────────────────
// Vendor webhooks (Stripe, Twilio, partner POS) bypass the global limiter so
// legitimately signed deliveries are never dropped behind normal API traffic.
// That bypass would let a flood of unsigned junk exhaust the server on
// signature verification alone, so they get their own cheap per-IP throttle
// mounted BEFORE any body parsing / signature work. The ceiling is far above
// any real vendor's delivery rate (Stripe/Twilio retry with backoff and stay
// in the low tens per minute even under load), so legitimate traffic is
// never throttled — only abusive hammering from a single source trips it.
// Known limitation: per-process in-memory, like the other limiters here —
// distributed rate limiting across instances is explicitly out of scope.

const WEBHOOK_WINDOW_MS = 60 * 1000;
const WEBHOOK_DEFAULT_MAX = 300; // 300 webhook requests / minute / IP

let webhookConfig = {
  enabled: !isTestEnv(),
  windowMs: WEBHOOK_WINDOW_MS,
  max: Number(process.env.WEBHOOK_RATE_LIMIT_MAX) > 0
    ? Number(process.env.WEBHOOK_RATE_LIMIT_MAX)
    : WEBHOOK_DEFAULT_MAX,
};

const webhookHits = new Map<string, WindowEntry>();

/** Pre-verification throttle for webhook endpoints. Mount before raw-body parsing. */
export function webhookRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (!webhookConfig.enabled) return next();
  const now = Date.now();
  const key = clientKey(req);
  const entry = webhookHits.get(key);
  if (!entry || now - entry.windowStart >= webhookConfig.windowMs) {
    webhookHits.set(key, { windowStart: now, count: 1 });
    sweep(webhookHits, webhookConfig.windowMs, now);
    return next();
  }
  entry.count++;
  if (entry.count > webhookConfig.max) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((entry.windowStart + webhookConfig.windowMs - now) / 1000),
    );
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: "Too many requests",
      message: `Webhook rate limit exceeded. Try again in ${retryAfterSec} second(s).`,
      retryAfterSeconds: retryAfterSec,
    });
    return;
  }
  next();
}

// ── Login brute-force guard ──────────────────────────────────────────────────
// Counts FAILED login attempts per source IP. After too many failures within
// the window the source is locked out for the remainder of the window and
// gets a clear "try again later" response. A successful login clears the
// counter for that source.

const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX_FAILURES = 5;

let loginConfig = {
  enabled: !isTestEnv(),
  windowMs: LOGIN_WINDOW_MS,
  maxFailures: LOGIN_MAX_FAILURES,
};

const loginFailures = new Map<string, WindowEntry>();

/**
 * Middleware for the login route: rejects with 429 while the source is
 * locked out. Does NOT count the attempt — call recordLoginFailure /
 * clearLoginFailures from the handler based on the outcome.
 */
export function loginBruteForceGuard(req: Request, res: Response, next: NextFunction): void {
  if (!loginConfig.enabled) return next();
  const now = Date.now();
  const entry = loginFailures.get(clientKey(req));
  if (!entry || now - entry.windowStart >= loginConfig.windowMs) return next();
  if (entry.count >= loginConfig.maxFailures) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((entry.windowStart + loginConfig.windowMs - now) / 1000),
    );
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: "Too many failed login attempts",
      message: `Too many failed login attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
      retryAfterSeconds: retryAfterSec,
    });
    return;
  }
  next();
}

/** Record a failed login attempt from this source. */
export function recordLoginFailure(req: Request, now = Date.now()): void {
  if (!loginConfig.enabled) return;
  const key = clientKey(req);
  const entry = loginFailures.get(key);
  if (!entry || now - entry.windowStart >= loginConfig.windowMs) {
    loginFailures.set(key, { windowStart: now, count: 1 });
    sweep(loginFailures, loginConfig.windowMs, now);
    return;
  }
  entry.count++;
}

/** Successful login: reset this source's failure counter. */
export function clearLoginFailures(req: Request): void {
  loginFailures.delete(clientKey(req));
}

// ── Test-only hooks ──────────────────────────────────────────────────────────

/** Test-only: force-enable/tune the global limiter (disabled under NODE_ENV=test). */
export function __configureGlobalRateLimitForTests(opts: {
  enabled: boolean;
  windowMs?: number;
  max?: number;
}): void {
  globalConfig = {
    enabled: opts.enabled,
    windowMs: opts.windowMs ?? GLOBAL_WINDOW_MS,
    max: opts.max ?? GLOBAL_DEFAULT_MAX,
  };
  globalHits.clear();
}

/** Test-only: force-enable/tune the webhook throttle (disabled under NODE_ENV=test). */
export function __configureWebhookRateLimitForTests(opts: {
  enabled: boolean;
  windowMs?: number;
  max?: number;
}): void {
  webhookConfig = {
    enabled: opts.enabled,
    windowMs: opts.windowMs ?? WEBHOOK_WINDOW_MS,
    max: opts.max ?? WEBHOOK_DEFAULT_MAX,
  };
  webhookHits.clear();
}

/** Test-only: force-enable/tune the login guard (disabled under NODE_ENV=test). */
export function __configureLoginGuardForTests(opts: {
  enabled: boolean;
  windowMs?: number;
  maxFailures?: number;
}): void {
  loginConfig = {
    enabled: opts.enabled,
    windowMs: opts.windowMs ?? LOGIN_WINDOW_MS,
    maxFailures: opts.maxFailures ?? LOGIN_MAX_FAILURES,
  };
  loginFailures.clear();
}

/** Test-only: clear all limiter state and restore env-derived defaults. */
export function __resetRateLimitsForTests(): void {
  __configureGlobalRateLimitForTests({ enabled: !isTestEnv() });
  __configureWebhookRateLimitForTests({ enabled: !isTestEnv() });
  __configureLoginGuardForTests({ enabled: !isTestEnv() });
}
