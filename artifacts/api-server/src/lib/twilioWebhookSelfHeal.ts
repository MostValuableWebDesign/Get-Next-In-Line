import {
  getTwilioWebhookStatus,
  configureTwilioWebhook,
  type TwilioWebhookCheck,
  type TwilioWebhookConfigureResult,
  type TwilioWebhookTarget,
} from "./sms";
import { logger } from "./logger";

// ── Twilio webhook domain-drift self-heal ────────────────────────────────────
// The Twilio number's inbound SMS/voice webhooks point at a fixed URL. When
// the app's public domain changes (dev domain rotation, production deploy),
// they silently go stale and inbound texts/calls stop reaching the app. This
// module re-uses the existing Settings-page check + auto-configure to repair
// the drift automatically: once shortly after startup, plus a low-frequency
// backstop from the concierge tick. Throttled so a persistent failure (e.g.
// insufficient token permissions) retries on the order of hours — the Twilio
// API is never spammed. Only the single active from-number (legacy/global
// scope) is handled, matching the manual Settings button.

/** After a clean pass (configured, fixed, or nothing to do): re-check this often. */
export const SELF_HEAL_OK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
/** After a failed repair attempt or an errored check: back off this long. */
export const SELF_HEAL_FAILURE_BACKOFF_MS = 4 * 60 * 60 * 1000; // 4h

export interface TwilioSelfHealDeps {
  getStatus: (tenantId?: number | null) => Promise<TwilioWebhookCheck>;
  configure: (
    tenantId: number | null,
    target: TwilioWebhookTarget,
  ) => Promise<TwilioWebhookConfigureResult>;
}

interface SelfHealState {
  /** Timestamps before this are throttled to a no-op. 0 = eligible now. */
  nextEligibleAtMs: number;
  /** Test-mode kill switch: no Twilio API traffic in the test suite. */
  enabled: boolean;
  deps: TwilioSelfHealDeps;
}

const defaultDeps: TwilioSelfHealDeps = {
  getStatus: (tenantId) => getTwilioWebhookStatus(tenantId),
  configure: (tenantId, target) => configureTwilioWebhook(tenantId, target),
};

const state: SelfHealState = {
  nextEligibleAtMs: 0,
  // Mirrors the transport itself: the connector proxy and rate limiters are
  // disabled under NODE_ENV=test, and so is this — tests opt in explicitly.
  enabled: process.env.NODE_ENV !== "test",
  deps: defaultDeps,
};

export interface TwilioSelfHealResult {
  /** False when skipped (disabled, throttled). */
  ran: boolean;
  /** Targets whose webhook was repaired this run. */
  repaired: TwilioWebhookTarget[];
  /** Targets whose repair was attempted and failed this run. */
  failed: TwilioWebhookTarget[];
}

const SKIPPED: TwilioSelfHealResult = { ran: false, repaired: [], failed: [] };

/**
 * One throttled self-heal pass: check the live webhook status; for each
 * target (sms, voice) that reports "misconfigured" with a valid expected
 * URL, run the existing auto-configure and log the outcome. Never throws.
 *
 * Precondition failures (no creds/proxy, no public URL, no number) and
 * already-configured targets make no repair calls — the underlying check is
 * a single status lookup, and even that is skipped entirely while throttled.
 */
export async function runTwilioWebhookSelfHeal(
  now: Date = new Date(),
): Promise<TwilioSelfHealResult> {
  if (!state.enabled) return SKIPPED;
  if (now.getTime() < state.nextEligibleAtMs) return SKIPPED;
  // Claim the slot up front so overlapping callers (startup kick + a
  // concurrent tick) can't both run; the real interval is set below.
  state.nextEligibleAtMs = now.getTime() + SELF_HEAL_FAILURE_BACKOFF_MS;

  const repaired: TwilioWebhookTarget[] = [];
  const failed: TwilioWebhookTarget[] = [];
  try {
    const check = await state.deps.getStatus(null);
    const targets: Array<{
      target: TwilioWebhookTarget;
      status: TwilioWebhookCheck["status"];
      expectedUrl: string | null;
    }> = [
      { target: "sms", status: check.status, expectedUrl: check.expectedUrl },
      { target: "voice", status: check.voiceStatus, expectedUrl: check.expectedVoiceUrl },
    ];

    for (const t of targets) {
      // Only a definite mismatch with a known expected URL is repairable.
      // "configured" needs nothing; precondition/error statuses (no creds,
      // no public URL, no number, API error) can't be fixed by us.
      if (t.status !== "misconfigured" || !t.expectedUrl) continue;
      const result = await state.deps.configure(null, t.target);
      if (result.fixed) {
        repaired.push(t.target);
        logger.info(
          { target: t.target, expectedUrl: t.expectedUrl, phoneNumber: check.phoneNumber },
          "Twilio webhook self-heal: repaired stale inbound webhook after domain change",
        );
      } else {
        failed.push(t.target);
        logger.warn(
          {
            target: t.target,
            expectedUrl: t.expectedUrl,
            phoneNumber: check.phoneNumber,
            errorMessage: result.errorMessage,
          },
          "Twilio webhook self-heal: repair attempt failed",
        );
      }
    }

    const hadError =
      failed.length > 0 || check.status === "error" || check.voiceStatus === "error";
    state.nextEligibleAtMs =
      now.getTime() + (hadError ? SELF_HEAL_FAILURE_BACKOFF_MS : SELF_HEAL_OK_INTERVAL_MS);
  } catch (err) {
    // Defensive: the underlying helpers already never throw.
    logger.error({ err }, "Twilio webhook self-heal pass failed");
    state.nextEligibleAtMs = now.getTime() + SELF_HEAL_FAILURE_BACKOFF_MS;
  }
  return { ran: true, repaired, failed };
}

/**
 * Test hook (same pattern as the rate limiters' __configure*ForTests):
 * force-enable/disable, inject fake status/configure deps, and reset the
 * throttle window.
 */
export function __configureTwilioSelfHealForTests(opts: {
  enabled?: boolean;
  deps?: Partial<TwilioSelfHealDeps>;
  resetThrottle?: boolean;
}): void {
  if (opts.enabled !== undefined) state.enabled = opts.enabled;
  if (opts.deps) state.deps = { ...defaultDeps, ...opts.deps };
  if (opts.resetThrottle) state.nextEligibleAtMs = 0;
}

/** Test hook: restore defaults so suites don't leak state into each other. */
export function __resetTwilioSelfHealForTests(): void {
  state.enabled = process.env.NODE_ENV !== "test";
  state.deps = defaultDeps;
  state.nextEligibleAtMs = 0;
}
