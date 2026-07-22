import express, { type Express } from "express";
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
const extraOrigins = (
  process.env.ALLOWED_ORIGINS ??
  "https://www.getnextinline.com,https://getnextinline.com"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
for (const origin of extraOrigins) {
  allowedOrigins.add(origin);
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

export default app;
