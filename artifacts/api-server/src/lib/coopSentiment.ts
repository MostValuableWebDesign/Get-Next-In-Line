import { logger } from "./logger";

/**
 * Co-op feedback sentiment analysis. Uses the Replit AI integration (OpenAI-
 * compatible proxy) when AI_INTEGRATIONS_OPENAI_* env vars are set; otherwise
 * falls back to a deterministic keyword analyzer so feedback ingestion keeps
 * working end-to-end. Runs at ingestion time so dashboards read precomputed
 * results — never at query time.
 */

export type SentimentLabel = "positive" | "neutral" | "negative";

export interface SentimentResult {
  label: SentimentLabel;
  /** Score in [-1, 1]; negative = unhappy. */
  score: number;
  /** Recurring topics mentioned, e.g. ["staff friendliness", "wait time"]. */
  themes: string[];
  usedAi: boolean;
}

// ── Deterministic keyword fallback ───────────────────────────────────────────

const POSITIVE_WORDS = [
  "great", "good", "love", "loved", "awesome", "amazing", "excellent",
  "fantastic", "friendly", "helpful", "wonderful", "perfect", "best",
  "delicious", "clean", "fast", "quick", "nice", "thanks", "thank",
  "recommend", "happy", "pleasant", "enjoyed",
];
const NEGATIVE_WORDS = [
  "bad", "terrible", "awful", "rude", "slow", "dirty", "worst", "hate",
  "hated", "disappointing", "disappointed", "poor", "unfriendly", "wait",
  "waited", "long", "expensive", "overpriced", "never", "cold", "mess",
  "confusing", "broken", "unhappy",
];

// Theme buckets: canonical theme name → trigger keywords.
export const THEME_KEYWORDS: Record<string, string[]> = {
  "staff friendliness": ["staff", "friendly", "unfriendly", "rude", "helpful", "team", "welcoming", "service"],
  "wait time": ["wait", "waited", "slow", "fast", "quick", "line", "queue", "prompt"],
  "quality": ["quality", "delicious", "fresh", "tasty", "excellent", "poor", "broken", "great work"],
  "value & pricing": ["price", "expensive", "overpriced", "cheap", "value", "deal", "worth"],
  "cleanliness": ["clean", "dirty", "tidy", "mess", "spotless", "hygiene"],
  "atmosphere": ["atmosphere", "vibe", "cozy", "loud", "music", "ambiance", "space", "neighborhood"],
};

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z']+/).filter(Boolean);
}

export function fallbackSentiment(text: string): SentimentResult {
  const words = tokenize(text);
  const wordSet = new Set(words);
  let pos = 0;
  let neg = 0;
  for (const w of words) {
    if (POSITIVE_WORDS.includes(w)) pos++;
    if (NEGATIVE_WORDS.includes(w)) neg++;
  }
  const total = pos + neg;
  const score = total === 0 ? 0 : Math.max(-1, Math.min(1, (pos - neg) / total));
  const label: SentimentLabel = score > 0.2 ? "positive" : score < -0.2 ? "negative" : "neutral";
  const lower = text.toLowerCase();
  const themes = Object.entries(THEME_KEYWORDS)
    .filter(([, keys]) => keys.some((k) => (k.includes(" ") ? lower.includes(k) : wordSet.has(k))))
    .map(([theme]) => theme);
  return { label, score: Math.round(score * 1000) / 1000, themes, usedAi: false };
}

/**
 * Analyze one piece of customer feedback text. AI path first (when the
 * integration is configured), deterministic keyword fallback otherwise or on
 * any AI failure. Never throws.
 */
export async function analyzeFeedbackSentiment(text: string): Promise<SentimentResult> {
  const trimmed = text.trim();
  if (!trimmed) return { label: "neutral", score: 0, themes: [], usedAi: false };

  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseUrl || !apiKey) return fallbackSentiment(trimmed);

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        max_completion_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You analyze short customer feedback about a local business visit. Respond with strict JSON: {"label":"positive"|"neutral"|"negative","score":number between -1 and 1,"themes":array of at most 3 short topic strings drawn from: ${Object.keys(THEME_KEYWORDS).join(", ")} (or a concise new topic when none fit)}.`,
          },
          { role: "user", content: trimmed.slice(0, 1000) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`AI proxy ${res.status}`);
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("empty AI response");
    const parsed = JSON.parse(content) as Partial<SentimentResult>;
    const label: SentimentLabel =
      parsed.label === "positive" || parsed.label === "negative" ? parsed.label : "neutral";
    const rawScore = typeof parsed.score === "number" && Number.isFinite(parsed.score) ? parsed.score : 0;
    const themes = Array.isArray(parsed.themes)
      ? parsed.themes.filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(0, 3)
      : [];
    return {
      label,
      score: Math.round(Math.max(-1, Math.min(1, rawScore)) * 1000) / 1000,
      themes,
      usedAi: true,
    };
  } catch (err) {
    logger.warn({ err }, "AI sentiment analysis failed; using keyword fallback");
    return fallbackSentiment(trimmed);
  }
}
