import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Allowed browser origins — shared by the CORS layer (app.ts) and the wallet
// CSRF origin guard (routes/wallet.ts).
// REPLIT_DOMAINS is a comma-separated list of all active domains for this repl
// (dev preview + any custom/production domains).
// ---------------------------------------------------------------------------
const rawDomains = process.env.REPLIT_DOMAINS ?? "";
export const allowedOrigins = new Set<string>(
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
