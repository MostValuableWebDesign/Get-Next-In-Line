import { createHash } from "crypto";
import { logger } from "./logger";

// ── Encryption key derivation with production fail-fast ─────────────────────
// Both at-rest encryption helpers (partner credentials, safety incident text)
// derive their AES-256 keys from SESSION_SECRET with a domain-separation
// label. In production a missing SESSION_SECRET must never silently fall
// back to the hardcoded dev value — encrypting real data under a key anyone
// can derive from the source is worse than refusing to run. This mirrors the
// SESSION_SECRET startup guard in app.ts (which already aborts production
// boot), and additionally protects any code path that reaches encryption
// without having gone through app.ts.

const DEV_FALLBACK_SECRET = "dev-fallback-secret-change-me";
const warnedLabels = new Set<string>();

/**
 * Derive a 32-byte AES key from SESSION_SECRET under a domain-separation
 * label. Throws in production when SESSION_SECRET is unset (no silent
 * fallback); outside production the dev fallback is allowed with a warning.
 */
export function deriveEncryptionKey(label: string): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `FATAL: SESSION_SECRET is not set. Refusing to derive the "${label}" ` +
          "encryption key from the hardcoded dev fallback in production — set " +
          "the SESSION_SECRET environment variable (a long random string) and restart.",
      );
    }
    if (!warnedLabels.has(label)) {
      warnedLabels.add(label);
      logger.warn(
        { label },
        "SESSION_SECRET is not set — deriving encryption key from the insecure dev fallback. Set SESSION_SECRET in production.",
      );
    }
  }
  return createHash("sha256")
    .update(`${label}:${secret ?? DEV_FALLBACK_SECRET}`)
    .digest();
}
