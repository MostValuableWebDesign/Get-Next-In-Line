import { db, sosSettingsTable } from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
import twilio from "twilio";
import { logger } from "./logger";
import {
  getStatusCallbackUrl,
  getInboundWebhookUrl,
  getInboundVoiceWebhookUrl,
} from "./inboundSms";

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
 * Obvious placeholder / fictional phone numbers that can never send real SMS.
 * Covers NANP "555" area-code fakes (e.g. the legacy demo +15550100000) and
 * the reserved fictional 555-0100..0199 exchange block. A placeholder left in
 * a settings row must never override a working connector/env From number —
 * Twilio rejects such sends with error 21659.
 */
export function isPlaceholderPhoneNumber(e164: string | null | undefined): boolean {
  if (!e164) return false;
  const digits = e164.replace(/\D/g, "");
  // +1 555 ... — 555 is not a real NANP area code.
  if (/^1?555\d{7}$/.test(digits)) return true;
  // +1 NXX 555-01XX — the reserved fictional exchange range.
  if (/^1?\d{3}55501\d{2}$/.test(digits)) return true;
  return false;
}

/**
 * Default recipient for admin "send test text" checks. Single source of
 * truth: the TEST_SMS_RECIPIENT env var, falling back to the platform
 * default. Always returned in E.164 form.
 */
export const DEFAULT_TEST_SMS_RECIPIENT = "+14703467558";
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
  activeFromNumberSource: FromNumberSource | null;
  ignoredFromNumber: string | null;
}> {
  const settings = await getSmsSettings(tenantId);
  const creds = await getTwilioCreds();
  const proxy = creds ? null : await getTwilioProxy();
  const resolved = resolveFromNumber(settings?.smsFromNumber, creds?.fromNumber);
  return {
    smsMode: (creds || proxy) && resolved.fromNumber ? "live" : "simulated",
    activeFromNumber: resolved.fromNumber,
    activeFromNumberSource: resolved.source,
    ignoredFromNumber: resolved.ignoredSettingsNumber,
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
  /**
   * Result of the same check for the number's "A call comes in" (VoiceUrl)
   * webhook — the AI receptionist's inbound call entry point. Precondition
   * failures (no creds/number/public URL) mirror `status`.
   */
  voiceStatus: TwilioWebhookCheckStatus;
  /** The URL the app expects Twilio's "A call comes in" webhook to be. */
  expectedVoiceUrl: string | null;
  /** The VoiceUrl currently configured on the number in Twilio (when reachable). */
  configuredVoiceUrl: string | null;
  errorMessage: string | null;
}

/** Which webhook on the Twilio number a fix targets. */
export type TwilioWebhookTarget = "sms" | "voice";

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
  const expectedVoiceUrl = getInboundVoiceWebhookUrl();
  const base: TwilioWebhookCheck = {
    status: "error",
    phoneNumber: null,
    expectedUrl,
    configuredUrl: null,
    voiceStatus: "error",
    expectedVoiceUrl,
    configuredVoiceUrl: null,
    errorMessage: null,
  };
  // Precondition failures apply to both webhooks identically.
  const failBoth = (status: TwilioWebhookCheckStatus, extra?: Partial<TwilioWebhookCheck>) => ({
    ...base,
    ...extra,
    status,
    voiceStatus: status,
  });
  if (!expectedUrl) return failBoth("no_public_url");

  const creds = await getTwilioCreds();
  const proxy = creds ? null : await getTwilioProxy();
  if (!creds && !proxy) return failBoth("no_credentials");

  const settings = await getSmsSettings(tenantId);
  const { fromNumber: phoneNumber } = resolveFromNumber(
    settings?.smsFromNumber,
    creds?.fromNumber,
  );
  if (!phoneNumber) return failBoth("no_number");

  try {
    let smsUrl: string | null | undefined;
    let voiceUrl: string | null | undefined;
    let found = false;
    if (creds) {
      const client = twilio(creds.accountSid, creds.authToken);
      const numbers = await client.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
      found = numbers.length > 0;
      smsUrl = numbers[0]?.smsUrl;
      voiceUrl = numbers[0]?.voiceUrl;
    } else if (proxy) {
      const res = await proxy.request(
        `/2010-04-01/Accounts/${proxy.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}&PageSize=1`,
      );
      if (!res.ok) throw new Error(`Twilio number lookup failed (HTTP ${res.status})`);
      const data = (await res.json()) as {
        incoming_phone_numbers?: Array<{ sms_url?: string | null; voice_url?: string | null }>;
      };
      found = (data.incoming_phone_numbers?.length ?? 0) > 0;
      smsUrl = data.incoming_phone_numbers?.[0]?.sms_url;
      voiceUrl = data.incoming_phone_numbers?.[0]?.voice_url;
    }
    if (!found) return failBoth("number_not_found", { phoneNumber });
    const configuredUrl = smsUrl?.trim() ? smsUrl.trim() : null;
    const matches =
      configuredUrl != null &&
      normalizeWebhookUrl(configuredUrl) === normalizeWebhookUrl(expectedUrl);
    const configuredVoiceUrl = voiceUrl?.trim() ? voiceUrl.trim() : null;
    const voiceMatches =
      expectedVoiceUrl != null &&
      configuredVoiceUrl != null &&
      normalizeWebhookUrl(configuredVoiceUrl) === normalizeWebhookUrl(expectedVoiceUrl);
    return {
      ...base,
      phoneNumber,
      configuredUrl,
      status: matches ? "configured" : "misconfigured",
      configuredVoiceUrl,
      voiceStatus: voiceMatches ? "configured" : "misconfigured",
    };
  } catch (err) {
    const e = err as { message?: string };
    logger.warn({ err }, "Twilio webhook-status check failed");
    return failBoth("error", {
      phoneNumber,
      errorMessage: e.message ?? "Twilio API request failed",
    });
  }
}

export interface TwilioWebhookConfigureResult {
  /** True when the Twilio number's smsUrl was successfully updated. */
  fixed: boolean;
  /** Fresh webhook check reflecting the state after the fix attempt. */
  check: TwilioWebhookCheck;
  /** Human-readable reason when the fix could not be applied. */
  errorMessage: string | null;
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
  // connector/env From number — unless it's an obvious placeholder, which is
  // ignored so it can't break every live send (Twilio error 21659).
  const { fromNumber } = resolveFromNumber(settings?.smsFromNumber, creds?.fromNumber);
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

/** Authoritative per-message status fetched from Twilio's Messages API. */
export interface TwilioMessageStatusFetch {
  /** Twilio message status, e.g. queued|sending|sent|delivered|undelivered|failed|read */
  messageStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Fetch the authoritative delivery status of one outbound message from
 * Twilio (SDK when raw creds exist, connector proxy otherwise). Never
 * throws; returns null when no live transport is available, the SID isn't a
 * Twilio message SID, or the lookup fails.
 */
export async function fetchTwilioMessageStatus(
  providerSid: string,
): Promise<TwilioMessageStatusFetch | null> {
  // Only real Twilio message SIDs (simulated sends record other markers).
  if (!/^SM[0-9a-f]{32}$/i.test(providerSid)) return null;
  const creds = await getTwilioCreds();
  const proxy = creds ? null : await getTwilioProxy();
  try {
    if (creds) {
      const client = twilio(creds.accountSid, creds.authToken);
      const message = await client.messages(providerSid).fetch();
      return {
        messageStatus: message.status,
        errorCode: message.errorCode != null ? String(message.errorCode) : null,
        errorMessage: message.errorMessage ?? null,
      };
    }
    if (proxy) {
      const res = await proxy.request(
        `/2010-04-01/Accounts/${proxy.accountSid}/Messages/${providerSid}.json`,
      );
      if (!res.ok) {
        logger.warn(
          { providerSid, httpStatus: res.status },
          "Twilio message status lookup failed",
        );
        return null;
      }
      const data = (await res.json().catch(() => null)) as {
        status?: string;
        error_code?: number | string | null;
        error_message?: string | null;
      } | null;
      if (!data?.status) return null;
      return {
        messageStatus: data.status,
        errorCode: data.error_code != null ? String(data.error_code) : null,
        errorMessage: data.error_message ?? null,
      };
    }
  } catch (err) {
    logger.warn({ err, providerSid }, "Twilio message status lookup threw");
  }
  return null;
}

/**
 * How delivery-status updates reach this app.
 * - "callbacks": raw Twilio creds exist, so StatusCallback signatures verify
 *   against the sending account's auth token.
 * - "polling": sends go through the connector proxy, which withholds the
 *   auth token — Twilio's callbacks can't be signature-verified here, so
 *   statuses are reconciled by polling Twilio's Messages API instead.
 * - "none": simulated mode, nothing to track.
 */
export type DeliveryStatusMode = "callbacks" | "polling" | "none";

export async function getDeliveryStatusMode(): Promise<DeliveryStatusMode> {
  const creds = await getTwilioCreds();
  if (creds) return "callbacks";
  const proxy = await getTwilioProxy();
  return proxy ? "polling" : "none";
}

export function getTestSmsRecipient(): string {
  return (
    normalizeToE164(process.env.TEST_SMS_RECIPIENT) ?? DEFAULT_TEST_SMS_RECIPIENT
  );
}

/**
 * Auto-configure one of the Twilio number's inbound webhooks — "A message
 * comes in" (SmsUrl, default) or "A call comes in" (VoiceUrl) — to point at
 * this app's matching inbound URL, then re-run the live check. Never throws —
 * every failure mode (missing creds/number, Twilio API rejection such as
 * insufficient token permissions) is reported in the result so the Settings
 * page can render it.
 */
export async function configureTwilioWebhook(
  tenantId?: number | null,
  target: TwilioWebhookTarget = "sms",
): Promise<TwilioWebhookConfigureResult> {
  const before = await getTwilioWebhookStatus(tenantId);
  const targetStatus = target === "voice" ? before.voiceStatus : before.status;
  const targetExpectedUrl = target === "voice" ? before.expectedVoiceUrl : before.expectedUrl;
  // Nothing to fix, or preconditions (creds / number / public URL) missing —
  // report the check as-is instead of attempting a doomed API call.
  if (targetStatus === "configured") {
    return { fixed: false, check: before, errorMessage: null };
  }
  if (targetStatus !== "misconfigured" || !targetExpectedUrl) {
    return {
      fixed: false,
      check: before,
      errorMessage:
        "The webhook can't be auto-configured until Twilio credentials, an SMS number, and a public URL are all available.",
    };
  }

  const expectedUrl = targetExpectedUrl;
  const phoneNumber = before.phoneNumber!;
  try {
    const creds = await getTwilioCreds();
    const proxy = creds ? null : await getTwilioProxy();
    if (creds) {
      const client = twilio(creds.accountSid, creds.authToken);
      const numbers = await client.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
      const sid = numbers[0]?.sid;
      if (!sid) throw new Error(`Number ${phoneNumber} not found in the Twilio account`);
      await client.incomingPhoneNumbers(sid).update(
        target === "voice"
          ? { voiceUrl: expectedUrl, voiceMethod: "POST" }
          : { smsUrl: expectedUrl, smsMethod: "POST" },
      );
    } else if (proxy) {
      const lookup = await proxy.request(
        `/2010-04-01/Accounts/${proxy.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}&PageSize=1`,
      );
      if (!lookup.ok) throw new Error(`Twilio number lookup failed (HTTP ${lookup.status})`);
      const data = (await lookup.json()) as {
        incoming_phone_numbers?: Array<{ sid?: string }>;
      };
      const sid = data.incoming_phone_numbers?.[0]?.sid;
      if (!sid) throw new Error(`Number ${phoneNumber} not found in the Twilio account`);
      const form =
        target === "voice"
          ? new URLSearchParams({ VoiceUrl: expectedUrl, VoiceMethod: "POST" })
          : new URLSearchParams({ SmsUrl: expectedUrl, SmsMethod: "POST" });
      const update = await proxy.request(
        `/2010-04-01/Accounts/${proxy.accountSid}/IncomingPhoneNumbers/${sid}.json`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        },
      );
      if (!update.ok) {
        const body = (await update.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Twilio webhook update failed (HTTP ${update.status})`);
      }
    } else {
      throw new Error("Twilio credentials are no longer available");
    }
  } catch (err) {
    const e = err as { message?: string };
    logger.warn({ err }, "Twilio webhook auto-configure failed");
    return {
      fixed: false,
      check: before,
      errorMessage: e.message ?? "Twilio API request failed",
    };
  }

  // Re-run the live check so the caller sees the post-fix state.
  const after = await getTwilioWebhookStatus(tenantId);
  const afterStatus = target === "voice" ? after.voiceStatus : after.status;
  return {
    fixed: afterStatus === "configured",
    check: after,
    errorMessage:
      afterStatus === "configured"
        ? null
        : "Twilio accepted the update but the webhook still doesn't match — re-check the number in the Twilio console.",
  };
}

/**
 * Resolve the From number that live sends will actually use. The tenant's
 * (or legacy global) settings override wins over the connector/env number —
 * unless it is an obvious placeholder or unparsable, in which case it is
 * ignored (with a warning) so it can't silently break every send.
 */
function resolveFromNumber(
  settingsNumber: string | null | undefined,
  credsNumber: string | null | undefined,
): { fromNumber: string | null; source: FromNumberSource | null; ignoredSettingsNumber: string | null } {
  const settingsRaw = settingsNumber?.trim() ? settingsNumber.trim() : null;
  if (settingsRaw) {
    const normalized = normalizeToE164(settingsRaw);
    if (normalized && !isPlaceholderPhoneNumber(normalized)) {
      return { fromNumber: normalized, source: "settings", ignoredSettingsNumber: null };
    }
    logger.warn(
      { smsFromNumber: settingsRaw },
      "Ignoring placeholder/invalid sms_from_number settings override; falling back to connector/env From number",
    );
    const fallback = normalizeToE164(credsNumber) ?? normalizeToE164(envFromNumber());
    return {
      fromNumber: fallback,
      source: fallback ? (normalizeToE164(credsNumber) ? "connector" : "env") : null,
      ignoredSettingsNumber: settingsRaw,
    };
  }
  const connector = normalizeToE164(credsNumber);
  if (connector) return { fromNumber: connector, source: "connector", ignoredSettingsNumber: null };
  const env = normalizeToE164(envFromNumber());
  if (env) return { fromNumber: env, source: "env", ignoredSettingsNumber: null };
  return { fromNumber: null, source: null, ignoredSettingsNumber: null };
}

export type FromNumberSource = "settings" | "connector" | "env";

export type FromNumberOwnership = "owned" | "not_owned" | "unverifiable";

/**
 * Check whether the connected Twilio account actually owns a phone number
 * (i.e. Twilio would accept it as a From number). "unverifiable" means no
 * live Twilio transport is available (simulated mode / tests) or the lookup
 * itself failed — callers must not treat that as a rejection.
 */
export async function verifyFromNumberOwnership(
  fromNumber: string,
): Promise<{ ownership: FromNumberOwnership; errorMessage: string | null }> {
  const creds = await getTwilioCreds();
  const proxy = creds ? null : await getTwilioProxy();
  if (!creds && !proxy) return { ownership: "unverifiable", errorMessage: null };
  try {
    let found = false;
    if (creds) {
      const client = twilio(creds.accountSid, creds.authToken);
      const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: fromNumber, limit: 1 });
      found = numbers.length > 0;
    } else if (proxy) {
      const res = await proxy.request(
        `/2010-04-01/Accounts/${proxy.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(fromNumber)}&PageSize=1`,
      );
      if (!res.ok) throw new Error(`Twilio number lookup failed (HTTP ${res.status})`);
      const data = (await res.json()) as {
        incoming_phone_numbers?: Array<{ phone_number?: string }>;
      };
      found = (data.incoming_phone_numbers?.length ?? 0) > 0;
    }
    return { ownership: found ? "owned" : "not_owned", errorMessage: null };
  } catch (err) {
    const e = err as { message?: string };
    logger.warn({ err }, "Twilio From-number ownership check failed");
    return { ownership: "unverifiable", errorMessage: e.message ?? "Twilio API request failed" };
  }
}

/**
 * One-time-per-boot cleanup: clear obvious placeholder sms_from_number values
 * (e.g. the legacy demo +15550100000) from every settings row so they can't
 * override a working Twilio number. Idempotent; returns cleared row count.
 */
export async function clearPlaceholderFromNumbers(): Promise<number> {
  const { isNotNull } = await import("drizzle-orm");
  const rows = await db
    .select({ id: sosSettingsTable.id, smsFromNumber: sosSettingsTable.smsFromNumber })
    .from(sosSettingsTable)
    .where(isNotNull(sosSettingsTable.smsFromNumber));
  let cleared = 0;
  for (const row of rows) {
    const raw = row.smsFromNumber?.trim();
    if (!raw) continue;
    const normalized = normalizeToE164(raw);
    if (normalized && isPlaceholderPhoneNumber(normalized)) {
      await db
        .update(sosSettingsTable)
        .set({ smsFromNumber: null, updatedAt: new Date() })
        .where(eq(sosSettingsTable.id, row.id));
      logger.warn(
        { settingsId: row.id, smsFromNumber: raw },
        "Cleared placeholder sms_from_number from settings row",
      );
      cleared++;
    }
  }
  return cleared;
}
