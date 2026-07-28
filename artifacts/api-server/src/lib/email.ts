import { logger } from "./logger";

/**
 * Low-level transactional email transport, mirroring ./sms.ts. Uses the
 * Resend API when credentials are available (via the Replit Resend connector
 * or the RESEND_API_KEY env var); otherwise reports "simulated" so product
 * flows keep working end-to-end in development and are explicit about the
 * fact that nothing was really sent.
 *
 * When credentials ARE present, failures are reported as "failed" with the
 * provider error — they never silently downgrade to "simulated".
 *
 * Message recording (the unified `messages` table) lives in ./messaging.ts —
 * all senders must go through `sendMessage` there, not call this directly.
 */

interface EmailCreds {
  apiKey: string;
  fromAddress: string;
}

// Cache creds briefly so per-message sends don't hammer the connector proxy.
let credsCache: { creds: EmailCreds | null; fetchedAt: number } | null = null;
const CREDS_TTL_MS = 60_000;

/** Test-only hook: clear the creds cache after env manipulation. */
export function __resetEmailCredsCache(): void {
  credsCache = null;
}

async function getEmailCreds(): Promise<EmailCreds | null> {
  if (credsCache && Date.now() - credsCache.fetchedAt < CREDS_TTL_MS) {
    return credsCache.creds;
  }
  const creds = await fetchEmailCreds();
  credsCache = { creds, fetchedAt: Date.now() };
  return creds;
}

const DEFAULT_FROM = "onboarding@resend.dev";

async function fetchEmailCreds(): Promise<EmailCreds | null> {
  // Replit Resend connector exposes credentials through the connectors proxy.
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (hostname && xReplitToken) {
    try {
      const res = await fetch(
        `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=resend`,
        { headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken } },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          items?: Array<{ settings?: Record<string, string> }>;
        };
        const settings = data.items?.[0]?.settings;
        const apiKey = settings?.api_key ?? settings?.apiKey;
        const fromAddress =
          settings?.from_email ?? settings?.fromEmail ?? DEFAULT_FROM;
        if (apiKey) return { apiKey, fromAddress };
      }
    } catch (err) {
      logger.warn({ err }, "Resend connector lookup failed; falling back");
    }
  }

  // Plain env var fallback
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    return {
      apiKey,
      fromAddress: process.env.EMAIL_FROM_ADDRESS ?? DEFAULT_FROM,
    };
  }
  return null;
}

/** Loose-but-practical email shape check shared by API validation and sends. */
export function isValidEmail(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 254;
}

/** Live vs. simulated email status. */
export async function getEmailStatus(): Promise<{
  emailMode: "live" | "simulated";
  activeFromAddress: string | null;
}> {
  const creds = await getEmailCreds();
  return {
    emailMode: creds ? "live" : "simulated",
    activeFromAddress: creds?.fromAddress ?? null,
  };
}

/**
 * Fully-qualified public base URL for links embedded in emails/SMS.
 * Recipients read these outside the app — relative paths are never usable.
 */
export function publicAppBaseUrl(): string {
  const fromEnv = process.env.APP_BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const domain =
    process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() ||
    process.env.REPLIT_DEV_DOMAIN;
  return domain ? `https://${domain}` : "http://localhost:5173";
}

export interface DeliverEmailResult {
  status: "sent" | "failed" | "simulated";
  toEmail: string | null;
  providerSid: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Attempt to deliver one email. Never throws; the outcome (including
 * provider errors and invalid recipient addresses in live mode) is reported
 * in the result so the caller can record it.
 */
export async function deliverEmail(
  toRaw: string | null | undefined,
  subject: string,
  body: string,
): Promise<DeliverEmailResult> {
  const creds = await getEmailCreds();
  const toEmail = toRaw?.trim() || null;

  let status: "sent" | "failed" | "simulated" = "simulated";
  let providerSid: string | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  if (creds) {
    if (!toEmail || !isValidEmail(toEmail)) {
      // Real email is active but this recipient's address is unusable — flag
      // it instead of silently pretending it was simulated.
      status = "failed";
      errorCode = "invalid_email";
      errorMessage = `Recipient email ${JSON.stringify(toRaw ?? null)} is not a valid address`;
      logger.warn({ toEmail: toRaw }, "Email skipped: invalid recipient address");
    } else {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${creds.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: creds.fromAddress,
            to: [toEmail],
            subject,
            text: body,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { id?: string };
          providerSid = data.id ?? null;
          status = "sent";
        } else {
          status = "failed";
          errorCode = String(res.status);
          const errBody = (await res.json().catch(() => null)) as {
            message?: string;
          } | null;
          errorMessage = errBody?.message ?? `Resend responded ${res.status}`;
          logger.error({ errorCode, errorMessage }, "Resend send failed");
        }
      } catch (err) {
        status = "failed";
        errorMessage = err instanceof Error ? err.message : "Unknown email error";
        logger.error({ err }, "Email send threw");
      }
    }
  }

  return { status, toEmail, providerSid, errorCode, errorMessage };
}
