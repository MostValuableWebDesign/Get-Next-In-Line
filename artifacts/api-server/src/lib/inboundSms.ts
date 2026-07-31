/**
 * Inbound SMS helpers: keyword parsing for reply-to-claim and opt-out
 * handling, plus the public webhook URL that must be configured in the
 * Twilio console ("A message comes in" → this URL).
 */

export type InboundKeyword = "yes" | "stop" | "start" | "none";

// Twilio-standard opt-out / opt-in keywords.
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "unstop", "subscribe"]);
const YES_WORDS = new Set(["yes", "y", "yea", "yeah", "yep", "yes!"]);

/**
 * Classify an inbound SMS body. Case-insensitive, tolerant of surrounding
 * whitespace and punctuation ("  YES!! " → "yes"). Only single-keyword
 * messages match — "yes please book me" is intentionally "none" so we never
 * claim a slot on an ambiguous message.
 */
export function parseInboundKeyword(body: string | null | undefined): InboundKeyword {
  if (!body) return "none";
  const cleaned = body.trim().toLowerCase().replace(/[^a-z]+/g, "");
  if (!cleaned) return "none";
  if (YES_WORDS.has(cleaned)) return "yes";
  if (STOP_WORDS.has(cleaned)) return "stop";
  if (START_WORDS.has(cleaned)) return "start";
  return "none";
}

/**
 * Public URL of the Twilio inbound-SMS webhook, based on the repl's active
 * domain. Null when no public domain is available (e.g. bare local dev).
 */
export function getInboundWebhookUrl(): string | null {
  const domain = getPublicDomain();
  return domain ? `https://${domain}/api/sos/twilio/inbound` : null;
}

/**
 * Public URL of the Twilio inbound voice webhook ("A call comes in" → this
 * URL), used by the AI receptionist. Null when no public domain is available.
 */
export function getInboundVoiceWebhookUrl(): string | null {
  const domain = getPublicDomain();
  return domain ? `https://${domain}/api/sos/twilio/voice` : null;
}

/**
 * Public URL Twilio should POST delivery-status updates to (the per-message
 * StatusCallback). Null when no public domain is available — sends then go
 * out without a callback and stay at their initial "sent" status.
 */
export function getStatusCallbackUrl(): string | null {
  const domain = getPublicDomain();
  return domain ? `https://${domain}/api/sos/twilio/status` : null;
}

function getPublicDomain(): string | null {
  return (
    (process.env.REPLIT_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean)[0] ??
    process.env.REPLIT_DEV_DOMAIN ??
    null
  );
}
