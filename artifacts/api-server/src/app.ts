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
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

// ---------------------------------------------------------------------------
// Allowed CORS origins
// REPLIT_DOMAINS is a comma-separated list of all active domains for this repl
// (dev preview + any custom/production domains).
// ---------------------------------------------------------------------------
const rawDomains = process.env.REPLIT_DOMAINS ?? "";
const allowedOrigins = new Set<string>(
  rawDomains
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => `https://${d}`),
);

// Production origins. Overridable via ALLOWED_ORIGINS (comma-separated full
// origins, e.g. "https://www.getnextinline.com,https://getnextinline.com").
// NOTE: setting ALLOWED_ORIGINS *replaces* these defaults. If it is set
// without the getnextinline.com origins, marketing-site logins break with a
// CORS error — warn loudly at startup so the misconfiguration isn't silent.
const DEFAULT_PRODUCTION_ORIGINS = [
  "https://www.getnextinline.com",
  "https://getnextinline.com",
];
const extraOrigins = (
  process.env.ALLOWED_ORIGINS ?? DEFAULT_PRODUCTION_ORIGINS.join(",")
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
for (const origin of extraOrigins) {
  allowedOrigins.add(origin);
}

if (process.env.ALLOWED_ORIGINS) {
  const missingDefaults = DEFAULT_PRODUCTION_ORIGINS.filter(
    (o) => !allowedOrigins.has(o),
  );
  if (missingDefaults.length > 0) {
    logger.warn(
      { missingOrigins: missingDefaults },
      `ALLOWED_ORIGINS is set but does not include the getnextinline.com defaults (${missingDefaults.join(
        ", ",
      )}). ALLOWED_ORIGINS *replaces* the built-in defaults, so logins from the marketing site will fail with a CORS error. Include these origins in ALLOWED_ORIGINS if that is not intended.`,
    );
  }
}

// Allow localhost variants in non-production for local development
if (process.env.NODE_ENV !== "production") {
  allowedOrigins.add("http://localhost:3000");
  allowedOrigins.add("http://localhost:5173");
  allowedOrigins.add("http://localhost:25576");
}

const app: Express = express();

// Trust Replit's reverse proxy so `req.protocol` reflects HTTPS and secure
// cookies work correctly behind the proxy layer.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
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
app.post(
  "/api/stripe/webhook",
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Session middleware
// SESSION_SECRET signs the session ID cookie — keep it secret.
// Cookie is HttpOnly + SameSite=Lax; secure is enabled whenever the repl
// is running on Replit (HTTPS) or in production.
// ---------------------------------------------------------------------------
const sessionSecret = process.env.SESSION_SECRET;
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

app.use(
  session({
    name: "gnil.sid",
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
  if (res.headersSent) {
    next(err);
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
