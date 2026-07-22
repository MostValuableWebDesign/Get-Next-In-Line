import { db, sosSettingsTable } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
import twilio from "twilio";
import { logger } from "./logger";
import { getStatusCallbackUrl } from "./inboundSms";

/**
 * Low-level SMS transport. Uses Twilio when credentials are available (via
 * the Replit Twilio connector or TWILIO_* env vars); otherwise reports
 * "simulated" so the product flow keeps working end-to-end and is explicit
 * about the fact that nothing was really sent.
 *
 * When credentials ARE present, failures are reported as "failed" with the
 * Twilio error code/message — they never silently downgrade to "simulated".
 *
 * Message recording (the unified `messages` table) lives in ./messaging.ts —
 * all senders must go through `sendMessage` there, not call this directly.
 */

interface TwilioCreds {
  accountSid: string;
  authToken: string;
  fromNumber: string | null;
}

// Cache creds briefly so per-message sends don't hammer the connector proxy.
let credsCache: { creds: TwilioCreds | null; fetchedAt: number } | null = null;
const CREDS_TTL_MS = 60_000;

async function getTwilioCreds(): Promise<TwilioCreds | null> {
  if (credsCache && Date.now() - credsCache.fetchedAt < CREDS_TTL_MS) {
    return credsCache.creds;
  }
  const creds = await fetchTwilioCreds();
  credsCache = { creds, fetchedAt: Date.now() };
  return creds;
}

async function fetchTwilioCreds(): Promise<TwilioCreds | null> {
  // Replit Twilio connector exposes credentials through the connectors proxy.
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (hostname && xReplitToken) {
    try {
      const res = await fetch(
        `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=twilio`,
        { headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken } },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          items?: Array<{ settings?: Record<string, string> }>;
        };
        const settings = data.items?.[0]?.settings;
        const accountSid = settings?.account_sid ?? settings?.accountSid;
        const authToken = settings?.api_key ?? settings?.auth_token ?? settings?.authToken;
        const fromNumber = settings?.phone_number ?? settings?.from_number ?? null;
        if (accountSid && authToken) {
          return { accountSid, authToken, fromNumber };
        }
      }
    } catch (err) {
      logger.warn({ err }, "Twilio connector lookup failed; falling back");
    }
  }

  // Plain env var fallback
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (accountSid && authToken) {
    return {
      accountSid,
      authToken,
      fromNumber: process.env.TWILIO_PHONE_NUMBER ?? null,
    };
  }
  return null;
}

/**
 * Normalize a phone number to E.164 (best effort, US-biased default country).
 * Returns null when the input can't plausibly be a valid number.
 */
export function normalizeToE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (hasPlus) {
    // Already international: just strip formatting.
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }
  if (digits.length === 10) return `+1${digits}`; // US/CA without country code
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

/**
 * Auth token used to verify Twilio inbound-webhook signatures. Falls back to
 * TWILIO_AUTH_TOKEN so signature validation can work even when outbound
 * sending is not fully configured (e.g. no From number yet).
 */
export async function getTwilioAuthToken(): Promise<string | null> {
  const creds = await getTwilioCreds();
  return creds?.authToken ?? process.env.TWILIO_AUTH_TOKEN ?? null;
}

/** The settings row that governs SMS for a given tenant context. */
async function getSmsSettings(tenantId?: number | null) {
  const [settings] = await db
    .select()
    .from(sosSettingsTable)
    .where(
      tenantId != null
        ? eq(sosSettingsTable.tenantId, tenantId)
        : isNull(sosSettingsTable.tenantId),
    )
    .orderBy(sosSettingsTable.id)
    .limit(1);
  return settings;
}

/** Live vs. simulated SMS status, for the Settings page. */
export async function getSmsStatus(tenantId?: number | null): Promise<{
  smsMode: "live" | "simulated";
  activeFromNumber: string | null;
}> {
  const settings = await getSmsSettings(tenantId);
  const creds = await getTwilioCreds();
  const fromNumber = normalizeToE164(settings?.smsFromNumber ?? creds?.fromNumber);
  return {
    smsMode: creds && fromNumber ? "live" : "simulated",
    activeFromNumber: fromNumber,
  };
}

export interface DeliverSmsResult {
  status: "sent" | "failed" | "simulated";
  /** Normalized E.164 recipient, when the raw number was usable. */
  toNumber: string | null;
  providerSid: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Attempt to deliver one SMS. Never throws; the outcome (including Twilio
 * errors and invalid recipient numbers in live mode) is reported in the
 * result so the caller can record it.
 */
export async function deliverSms(
  toRaw: string | null | undefined,
  body: string,
  tenantId?: number | null,
): Promise<DeliverSmsResult> {
  const settings = await getSmsSettings(tenantId);
  const creds = await getTwilioCreds();
  // The tenant's (or legacy global) settings override wins over the
  // connector/env From number.
  const fromNumber = normalizeToE164(settings?.smsFromNumber ?? creds?.fromNumber);
  const toNumber = normalizeToE164(toRaw);

  let status: "sent" | "failed" | "simulated" = "simulated";
  let providerSid: string | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  if (creds && fromNumber) {
    if (!toNumber) {
      // Real SMS is active but this recipient's number is unusable — flag it
      // instead of silently pretending it was simulated.
      status = "failed";
      errorCode = "invalid_number";
      errorMessage = `Recipient phone number ${JSON.stringify(toRaw ?? null)} is not a valid E.164 number`;
      logger.warn({ toNumber: toRaw }, "SMS skipped: invalid recipient number");
    } else {
      try {
        const client = twilio(creds.accountSid, creds.authToken);
        const statusCallback = getStatusCallbackUrl();
        const message = await client.messages.create({
          to: toNumber,
          from: fromNumber,
          body,
          ...(statusCallback ? { statusCallback } : {}),
        });
        providerSid = message.sid;
        if (message.status === "failed" || message.status === "undelivered") {
          status = "failed";
          errorCode = message.errorCode != null ? String(message.errorCode) : null;
          errorMessage = message.errorMessage ?? null;
          logger.error(
            { sid: message.sid, errorCode, errorMessage },
            "Twilio message failed",
          );
        } else {
          status = "sent";
        }
      } catch (err) {
        status = "failed";
        const e = err as { code?: number | string; message?: string; status?: number };
        errorCode = e.code != null ? String(e.code) : null;
        errorMessage = e.message ?? "Unknown Twilio error";
        logger.error({ err, errorCode }, "Twilio send failed");
      }
    }
  }

  return { status, toNumber, providerSid, errorCode, errorMessage };
}
