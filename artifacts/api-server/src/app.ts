import express, { type Express, type Request, type Response, type NextFunction } from "express";
// NOTE: api-zod schemas may come from a different zod module instance than
// this package's, so `instanceof ZodError` is unreliable — duck-type instead.
function isZodError(err: unknown): err is { issues: Array<{ path: Array<string | number>; message: string }> } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ZodError" &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";
import { globalRateLimit, webhookRateLimit } from "./middlewares/rateLimit";

// Allowed browser origins — built in lib/allowedOrigins so the wallet CSRF
// origin guard shares exactly the same allowlist as this CORS layer.
import { allowedOrigins } from "./lib/allowedOrigins";

const app: Express = express();

export function serializeRequestForLog(req: { id?: unknown; method?: unknown; url?: string }) {
  return {
    id: req.id,
    method: req.method,
    // Fragments are not normally sent in HTTP requests, but strip them
    // defensively alongside query strings so access logs cannot retain a
    // browser capability if an upstream ever forwards one unexpectedly.
    url: req.url?.split(/[?#]/)[0],
  };
}

// Trust Replit's reverse proxy so `req.protocol` reflects HTTPS and secure
// cookies work correctly behind the proxy layer.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return serializeRequestForLog(req);
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(
  cors({
    // Deny requests from origins not in the allowlist
    origin(origin, callback) {
      // No-origin requests (same-origin browser fetches, health-check curl, etc.)
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' is not allowed`));
    },
    credentials: true, // Required for session cookies to be forwarded
  }),
);

// Stripe webhook must be registered BEFORE express.json(): signature
// verification requires the raw request body as a Buffer.
// Both raw-body webhook mounts below bypass the global rate limiter (mounted
// after them), so they carry their own cheap per-IP flood throttle that runs
// BEFORE body parsing and signature verification — a flood of unsigned junk
// gets 429s instead of exhausting the server on crypto work.
app.post(
  "/api/stripe/webhook",
  webhookRateLimit,
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature" });
      return;
    }
    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;
      const { WebhookHandlers } = await import("./lib/webhookHandlers");
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (err) {
      logger.error({ err }, "Stripe webhook processing failed");
      res.status(400).json({ error: "Webhook processing error" });
    }
  },
);

// Partner-Direct webhooks also need the raw body: each connection's HMAC
// signature (issued at authorization time) is verified over the exact bytes
// sent. Signature is the only authentication — no session involved.
app.post(
  "/api/v1/partners/:partnerId/webhook",
  webhookRateLimit,
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      const { handlePartnerWebhook, PARTNER_WEBHOOK_SIGNATURE_HEADER } = await import(
        "./routes/partners"
      );
      const sig = req.headers[PARTNER_WEBHOOK_SIGNATURE_HEADER];
      const tenantHeader = req.headers["x-tenant-id"];
      const out = await handlePartnerWebhook(
        // Adding the throttle middleware widens express's params inference to
        // string | string[]; the single-segment param is always a string.
        String(req.params.partnerId),
        Array.isArray(tenantHeader) ? tenantHeader[0] : tenantHeader,
        Buffer.isBuffer(req.body) ? req.body : Buffer.from(""),
        Array.isArray(sig) ? sig[0] : sig,
      );
      res.status(out.http).json(out.body);
    } catch (err) {
      logger.error({ err }, "Partner webhook processing failed");
      res.status(500).json({ error: "Webhook processing error" });
    }
  },
);

// Global rate limit. Mounted AFTER the raw-body webhook routes above, so
// vendor-signed webhook deliveries (Stripe, partners) are never throttled, and it
// internally skips /api/healthz. Everything else gets a generous per-IP
// ceiling that returns 429 + Retry-After when exceeded.
app.use(globalRateLimit);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Session middleware
// SESSION_SECRET signs the session ID cookie — keep it secret.
// Cookie is HttpOnly + SameSite=Lax; secure is enabled whenever the repl
// is running on Replit (HTTPS) or in production.
// ---------------------------------------------------------------------------
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret && process.env.NODE_ENV === "production") {
  // Fail fast: running production with the hardcoded dev fallback would let
  // anyone who reads the source forge session cookies. Abort before the
  // server accepts any traffic.
  throw new Error(
    "FATAL: SESSION_SECRET is not set. The API server refuses to start in " +
      "production without a real session secret — set the SESSION_SECRET " +
      "environment variable (a long random string) and restart.",
  );
}
if (!sessionSecret) {
  logger.warn(
    "SESSION_SECRET is not set — using an insecure fallback. Set SESSION_SECRET in production.",
  );
}

const isHttps =
  Boolean(process.env.REPLIT_DEV_DOMAIN) ||
  process.env.NODE_ENV === "production";

// The production frontend (getnextinline.com) and this API (a *.replit.app
// domain) are different sites. With SameSite=Lax the browser drops the
// session cookie on cross-site fetches, so logins would silently fail even
// though CORS passes. Cross-site cookies require SameSite=None, which
// browsers only accept together with Secure — so we use "none" whenever the
// cookie is Secure (Replit dev + production) and fall back to "lax" for
// plain-HTTP local development, where "none" would be rejected.
const sameSite: "none" | "lax" = isHttps ? "none" : "lax";

// Persistent session store: sessions live in the existing Postgres database
// (the "session" table, owned by the Drizzle schema — see lib/db
// schema/sessions.ts) so logins survive server restarts and redeploys. The
// store prunes expired rows on an interval; under tests pruning is disabled
// so no timer keeps the vitest process alive (expired rows are inert — the
// store ignores them on read).
// Some unit tests mock @workspace/db without a `pool` export; fall back to
// the default in-memory store there (never in real runs, where pool exists).
const PgSessionStore = connectPgSimple(session);
const sessionStore = pool
  ? new PgSessionStore({
      pool,
      tableName: "session",
      createTableIfMissing: false, // table is managed by Drizzle migrations
      // VITEST covers suites that stub NODE_ENV (e.g. the production
      // fail-fast guard test) — pruning timers must never keep vitest alive.
      pruneSessionInterval:
        process.env.NODE_ENV === "test" || process.env.VITEST
          ? false
          : 15 * 60, // seconds
    })
  : undefined;

app.use(
  session({
    name: "gnil.sid",
    store: sessionStore,
    secret: sessionSecret ?? "dev-fallback-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isHttps,
      sameSite,
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  }),
);

app.use("/api", router);

// Structured error responses: Zod validation failures become 400s with the
// issue list instead of the default HTML 500 page.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  // Missing/malformed tenant context on a tenant-scoped route → 400. Duck-type
  // on the error name (same rationale as ZodError above).
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "TenantContextError"
  ) {
    res.status(400).json({ message: (err as Error).message });
    return;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "AppBusinessConfigurationError"
  ) {
    res.status(503).json({ message: (err as Error).message });
    return;
  }
  if (res.headersSent) {
    next(err);
    return;
  }
  // Disallowed-origin browser requests (rejected by the CORS allowlist above)
  // are a deliberate refusal, not a server fault: 403, not 500. This also
  // stops cross-site form POSTs (which skip preflight) from ever reaching a
  // cookie-authenticated handler such as the wallet routes.
  if (err instanceof Error && err.message.startsWith("CORS:")) {
    res.status(403).json({ message: "Cross-origin request rejected" });
    return;
  }
  if (isZodError(err)) {
    res.status(400).json({
      error: "Validation failed",
      issues: err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  logger.error({ err }, "Unhandled request error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;
