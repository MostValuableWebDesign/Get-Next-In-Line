import { db, sosSettingsTable } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
import twilio from "twilio";
import { logger } from "./logger";
import { getStatusCallbackUrl, getInboundWebhookUrl } from "./inboundSms";

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

// ---- Connector-proxy transport ---------------------------------------------
// The current Replit Twilio connector withholds raw credentials (its
// connection settings are empty), so the legacy creds fetch above returns
// nothing for it. All API calls must instead go through the Replit connectors
// proxy, which injects auth server-side. This transport covers outbound sends
// and number lookups; signature validation of inbound webhooks still requires
// a raw TWILIO_AUTH_TOKEN env var because Twilio signatures are HMACs of the
// auth token itself.

interface TwilioProxy {
  accountSid: string;
  request: (
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<Response>;
}

let connectorsClientPromise: Promise<
  import("@replit/connectors-sdk").ReplitConnectors | null
> | null = null;

function getConnectorsClient() {
  if (!connectorsClientPromise) {
    connectorsClientPromise = (async () => {
      if (!process.env.REPLIT_CONNECTORS_HOSTNAME) return null;
      try {
        const { ReplitConnectors } = await import("@replit/connectors-sdk");
        return new ReplitConnectors();
      } catch (err) {
        logger.warn({ err }, "Connectors SDK unavailable; Twilio proxy transport disabled");
        return null;
      }
    })();
  }
  return connectorsClientPromise;
}

let proxyCache: { proxy: TwilioProxy | null; fetchedAt: number } | null = null;
let proxyRefreshInFlight: Promise<TwilioProxy | null> | null = null;

async function getTwilioProxy(): Promise<TwilioProxy | null> {
  if (proxyCache && Date.now() - proxyCache.fetchedAt < CREDS_TTL_MS) {
    return proxyCache.proxy;
  }
  // Single-flight refresh: concurrent callers share one fetch instead of
  // racing, and a transient failed refresh never clobbers a previously
  // working proxy (we keep the old one and retry after the TTL).
  if (!proxyRefreshInFlight) {
    proxyRefreshInFlight = fetchTwilioProxy()
      .then((proxy) => {
        const kept = proxy ?? proxyCache?.proxy ?? null;
        proxyCache = { proxy: kept, fetchedAt: Date.now() };
        return kept;
      })
      .finally(() => {
        proxyRefreshInFlight = null;
      });
  }
  return proxyRefreshInFlight;
}

async function fetchTwilioProxy(): Promise<TwilioProxy | null> {
  // The proxy injects real credentials server-side, so it must never be
  // active in the test suite — tests rely on the simulated transport (the
  // same pattern as the rate limiters, which are disabled under test).
  if (process.env.NODE_ENV === "test") return null;
  const client = await getConnectorsClient();
  if (!client) return null;
  try {
    const res = await client.proxy("twilio", "/2010-04-01/Accounts.json", { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as { accounts?: Array<{ sid?: string }> };
    const accountSid = data.accounts?.[0]?.sid;
    if (!accountSid) return null;
    return {
      accountSid,
      request: (path, init) => client.proxy("twilio", path, init),
    };
  } catch (err) {
    logger.warn({ err }, "Twilio connector proxy unavailable; falling back");
    return null;
  }
}

/** From number available to proxy-mode sends (no creds object to carry it). */
function envFromNumber(): string | null {
  return process.env.TWILIO_PHONE_NUMBER ?? null;
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
  const proxy = creds ? null : await getTwilioProxy();
  const fromNumber = normalizeToE164(
    settings?.smsFromNumber ?? creds?.fromNumber ?? envFromNumber(),
  );
  return {
    smsMode: (creds || proxy) && fromNumber ? "live" : "simulated",
    activeFromNumber: fromNumber,
  };
}

export type TwilioWebhookCheckStatus =
  | "configured"
  | "misconfigured"
  | "no_credentials"
  | "no_public_url"
  | "no_number"
  | "number_not_found"
  | "error";

export interface TwilioWebhookCheck {
  status: TwilioWebhookCheckStatus;
  /** The E.164 number whose console configuration was checked. */
  phoneNumber: string | null;
  /** The URL the app expects Twilio's "A message comes in" webhook to be. */
  expectedUrl: string | null;
  /** The URL currently configured on the number in Twilio (when reachable). */
  configuredUrl: string | null;
  errorMessage: string | null;
}

/** Ignore trailing-slash and case-of-scheme/host differences when comparing webhook URLs. */
function normalizeWebhookUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

/**
 * Live check (via Twilio's API) of whether the active SMS number's
 * "A message comes in" webhook actually points at this app's inbound URL.
 * Never throws — every failure mode is reported as a status so the Settings
 * page can render it.
 */
export async function getTwilioWebhookStatus(
  tenantId?: number | null,
): Promise<TwilioWebhookCheck> {
  const expectedUrl = getInboundWebhookUrl();
  const base: TwilioWebhookCheck = {
    status: "error",
    phoneNumber: null,
    expectedUrl,
    configuredUrl: null,
    errorMessage: null,
  };
  if (!expectedUrl) return { ...base, status: "no_public_url" };

  const creds = await getTwilioCreds();
  const proxy = creds ? null : await getTwilioProxy();
  if (!creds && !proxy) return { ...base, status: "no_credentials" };

  const settings = await getSmsSettings(tenantId);
  const phoneNumber = normalizeToE164(
    settings?.smsFromNumber ?? creds?.fromNumber ?? envFromNumber(),
  );
  if (!phoneNumber) return { ...base, status: "no_number" };

  try {
    let smsUrl: string | null | undefined;
    let found = false;
    if (creds) {
      const client = twilio(creds.accountSid, creds.authToken);
      const numbers = await client.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
      found = numbers.length > 0;
      smsUrl = numbers[0]?.smsUrl;
    } else if (proxy) {
      const res = await proxy.request(
        `/2010-04-01/Accounts/${proxy.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}&PageSize=1`,
      );
      if (!res.ok) throw new Error(`Twilio number lookup failed (HTTP ${res.status})`);
      const data = (await res.json()) as {
        incoming_phone_numbers?: Array<{ sms_url?: string | null }>;
      };
      found = (data.incoming_phone_numbers?.length ?? 0) > 0;
      smsUrl = data.incoming_phone_numbers?.[0]?.sms_url;
    }
    if (!found) return { ...base, phoneNumber, status: "number_not_found" };
    const configuredUrl = smsUrl?.trim() ? smsUrl.trim() : null;
    const matches =
      configuredUrl != null &&
      normalizeWebhookUrl(configuredUrl) === normalizeWebhookUrl(expectedUrl);
    return {
      ...base,
      phoneNumber,
      configuredUrl,
      status: matches ? "configured" : "misconfigured",
    };
  } catch (err) {
    const e = err as { message?: string };
    logger.warn({ err }, "Twilio webhook-status check failed");
    return {
      ...base,
      phoneNumber,
      status: "error",
      errorMessage: e.message ?? "Twilio API request failed",
    };
  }
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
  const proxy = creds ? null : await getTwilioProxy();
  // The tenant's (or legacy global) settings override wins over the
  // connector/env From number.
  const fromNumber = normalizeToE164(
    settings?.smsFromNumber ?? creds?.fromNumber ?? envFromNumber(),
  );
  const toNumber = normalizeToE164(toRaw);

  let status: "sent" | "failed" | "simulated" = "simulated";
  let providerSid: string | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  if ((creds || proxy) && fromNumber) {
    if (!toNumber) {
      // Real SMS is active but this recipient's number is unusable — flag it
      // instead of silently pretending it was simulated.
      status = "failed";
      errorCode = "invalid_number";
      errorMessage = `Recipient phone number ${JSON.stringify(toRaw ?? null)} is not a valid E.164 number`;
      logger.warn({ toNumber: toRaw }, "SMS skipped: invalid recipient number");
    } else if (proxy) {
      // Connector-proxy transport: same Twilio REST semantics, auth injected
      // by the proxy. Failures report exactly like the SDK path — they never
      // downgrade to "simulated".
      try {
        const statusCallback = getStatusCallbackUrl();
        const form = new URLSearchParams({ To: toNumber, From: fromNumber, Body: body });
        if (statusCallback) form.set("StatusCallback", statusCallback);
        const res = await proxy.request(
          `/2010-04-01/Accounts/${proxy.accountSid}/Messages.json`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString(),
          },
        );
        const data = (await res.json().catch(() => null)) as {
          sid?: string;
          status?: string;
          code?: number | string;
          error_code?: number | string | null;
          error_message?: string | null;
          message?: string;
        } | null;
        if (!res.ok) {
          status = "failed";
          errorCode = data?.code != null ? String(data.code) : String(res.status);
          errorMessage = data?.message ?? "Twilio API error";
          logger.error({ errorCode, errorMessage }, "Twilio send failed (connector proxy)");
        } else {
          providerSid = data?.sid ?? null;
          if (data?.status === "failed" || data?.status === "undelivered") {
            status = "failed";
            errorCode = data.error_code != null ? String(data.error_code) : null;
            errorMessage = data.error_message ?? null;
            logger.error(
              { sid: providerSid, errorCode, errorMessage },
              "Twilio message failed",
            );
          } else {
            status = "sent";
          }
        }
      } catch (err) {
        status = "failed";
        const e = err as { code?: number | string; message?: string };
        errorCode = e.code != null ? String(e.code) : null;
        errorMessage = e.message ?? "Unknown Twilio error";
        logger.error({ err, errorCode }, "Twilio send failed (connector proxy)");
      }
    } else if (creds) {
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
