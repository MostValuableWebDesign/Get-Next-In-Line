import { logger } from "./logger";

/**
 * AI receptionist intent parsing. Uses the Replit AI integration (OpenAI-
 * compatible proxy) when AI_INTEGRATIONS_OPENAI_* env vars are set; otherwise
 * falls back to a deterministic keyword parser so the receptionist flow keeps
 * working end-to-end.
 */

export interface ParsedCallIntent {
  intent: "book_appointment" | "reschedule" | "question" | "other";
  serviceType: string | null;
  requestedTime: string | null; // ISO if parseable
  summary: string;
  usedAi: boolean;
}

// Industry-neutral service terms for the deterministic fallback parser.
// Keep these generic — the AI path handles business-specific phrasing.
const SERVICE_KEYWORDS = [
  "consultation",
  "appointment",
  "checkup",
  "estimate",
  "cleaning",
  "repair",
  "maintenance",
  "service",
  "reservation",
  "follow-up",
];

/**
 * Parse a comma-separated service-names setting into a clean, de-duplicated
 * (case-insensitive) list. Mirrors `parseServiceNames` in the web app's
 * service-type-input so staff-booked and AI-booked appointments share the
 * same vocabulary.
 */
export function parseServiceNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function fallbackParse(inquiry: string, serviceNames: string[] = []): ParsedCallIntent {
  const lower = inquiry.toLowerCase();
  const wantsBooking =
    /\b(book|appointment|schedule|reserve|reservation|come in|slot|opening)\b/.test(lower);
  const wantsReschedule = /\b(reschedule|move|change my)\b/.test(lower);
  // Business-specific service names take priority over the generic terms.
  const serviceType =
    serviceNames.find((k) => lower.includes(k.toLowerCase())) ??
    SERVICE_KEYWORDS.find((k) => lower.includes(k)) ??
    null;

  let requestedTime: string | null = null;
  const now = new Date();
  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    requestedTime = d.toISOString();
  } else if (/\btoday\b/.test(lower)) {
    const d = new Date(now);
    d.setHours(Math.min(now.getHours() + 2, 17), 0, 0, 0);
    requestedTime = d.toISOString();
  }

  return {
    intent: wantsReschedule
      ? "reschedule"
      : wantsBooking
        ? "book_appointment"
        : /\?|how|when|do you|price|cost|open/.test(lower)
          ? "question"
          : "other",
    serviceType,
    requestedTime,
    summary: inquiry.slice(0, 300),
    usedAi: false,
  };
}

export async function parseCallIntent(
  inquiry: string,
  callerName: string | null,
  nowIso: string,
  serviceNames: string[] = [],
): Promise<ParsedCallIntent> {
  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseUrl || !apiKey) {
    return fallbackParse(inquiry, serviceNames);
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        max_completion_tokens: 8192,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You are an AI receptionist for a service business. Current time: ${nowIso}.${serviceNames.length > 0 ? ` The business offers these services: ${serviceNames.join(", ")}. When the caller mentions one of them (or a close paraphrase), use that exact service name as serviceType.` : ""} Parse the caller's inquiry and respond with strict JSON: {"intent":"book_appointment"|"reschedule"|"question"|"other","serviceType":string|null,"requestedTime":ISO-8601 string|null,"summary":string (one concise sentence describing what the caller wants)}.`,
          },
          {
            role: "user",
            content: `Caller${callerName ? ` (${callerName})` : ""}: ${inquiry}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`AI proxy ${res.status}`);
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("empty AI response");
    const parsed = JSON.parse(content) as Partial<ParsedCallIntent>;
    return {
      intent:
        parsed.intent === "book_appointment" ||
        parsed.intent === "reschedule" ||
        parsed.intent === "question"
          ? parsed.intent
          : "other",
      serviceType: parsed.serviceType ?? null,
      requestedTime: parsed.requestedTime ?? null,
      summary: parsed.summary ?? inquiry.slice(0, 300),
      usedAi: true,
    };
  } catch (err) {
    logger.warn({ err }, "AI intent parse failed; using fallback parser");
    return fallbackParse(inquiry, serviceNames);
  }
}
