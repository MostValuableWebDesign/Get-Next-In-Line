import { logger } from "./logger";

// ── Stripe managed-webhook domain-drift self-heal ────────────────────────────
// The Stripe managed webhook is registered once at startup with the domain
// read at boot. When the app's public domain rotates while the server stays
// up (dev domain rotation), Stripe events (deposit holds, checkout
// completion) silently stop arriving until a restart. This module mirrors
// the Twilio webhook self-heal: a low-frequency, throttled pass re-verifies
// the managed webhook URL against the CURRENT domain and re-registers it on
// drift — once shortly after startup plus a backstop from the concierge
// tick. Throttled so a persistent failure retries on the order of hours;
// the Stripe API is never spammed. No Stripe traffic at all under test mode
// or when the Stripe connector isn't configured.

/** After a clean pass (in sync, repaired, or nothing to do): re-check this often. */
export const STRIPE_SELF_HEAL_OK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
/** After a failed check/repair: back off this long. */
export const STRIPE_SELF_HEAL_FAILURE_BACKOFF_MS = 4 * 60 * 60 * 1000; // 4h

/** Minimal slice of StripeSync used here — injectable for tests. */
export interface StripeSelfHealSync {
  getManagedWebhookByUrl(url: string): Promise<{ id: string; url: string } | null>;
  findOrCreateManagedWebhook(url: string): Promise<{ id: string; url: string }>;
}

export interface StripeSelfHealDeps {
  isConfigured: () => boolean;
  getSync: () => Promise<StripeSelfHealSync>;
  /** Current public webhook URL, or null when no public domain is known. */
  getExpectedUrl: () => string | null;
}

/** Same derivation as initStripe(): first REPLIT_DOMAINS entry at call time. */
export function currentStripeWebhookUrl(): string | null {
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (!domain) return null;
  return `https://${domain}/api/stripe/webhook`;
}

const defaultDeps: StripeSelfHealDeps = {
  isConfigured: () => {
    // Lazy require-free check mirroring stripeClient.isStripeConfigured
    // without importing the heavy module at load time.
    return Boolean(
      process.env.REPLIT_CONNECTORS_HOSTNAME &&
        (process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL),
    );
  },
  getSync: async () => {
    const { getStripeSync } = await import("./stripeClient");
    return getStripeSync();
  },
  getExpectedUrl: currentStripeWebhookUrl,
};

interface SelfHealState {
  /** Timestamps before this are throttled to a no-op. 0 = eligible now. */
  nextEligibleAtMs: number;
  /** Test-mode kill switch: no Stripe API traffic in the test suite. */
  enabled: boolean;
  deps: StripeSelfHealDeps;
}

const state: SelfHealState = {
  nextEligibleAtMs: 0,
  // Mirrors the Twilio self-heal: disabled under NODE_ENV=test — tests opt
  // in explicitly via the __configure hook.
  enabled: process.env.NODE_ENV !== "test",
  deps: defaultDeps,
};

export interface StripeSelfHealResult {
  /** False when skipped (disabled, throttled, unconfigured, no public URL). */
  ran: boolean;
  /** True when the managed webhook was re-registered at the new URL this run. */
  repaired: boolean;
  /** True when the check or repair attempt errored this run. */
  failed: boolean;
}

const SKIPPED: StripeSelfHealResult = { ran: false, repaired: false, failed: false };

/**
 * One throttled self-heal pass: compute the expected webhook URL from the
 * CURRENT public domain, look up the managed webhook at that URL, and if
 * none exists, register it (findOrCreateManagedWebhook is idempotent — it
 * reuses an existing endpoint at the same URL or creates a new one). Never
 * throws.
 *
 * Skips silently (no Stripe API calls, and no throttle consumed) when
 * disabled, when the Stripe connector isn't configured, or when no public
 * domain is known.
 */
export async function runStripeWebhookSelfHeal(
  now: Date = new Date(),
): Promise<StripeSelfHealResult> {
  if (!state.enabled) return SKIPPED;
  if (!state.deps.isConfigured()) return SKIPPED;
  const expectedUrl = state.deps.getExpectedUrl();
  if (!expectedUrl) return SKIPPED;
  if (now.getTime() < state.nextEligibleAtMs) return SKIPPED;
  // Claim the slot up front so overlapping callers (startup kick + a
  // concurrent tick) can't both run; the real interval is set below.
  state.nextEligibleAtMs = now.getTime() + STRIPE_SELF_HEAL_FAILURE_BACKOFF_MS;

  try {
    const sync = await state.deps.getSync();
    const existing = await sync.getManagedWebhookByUrl(expectedUrl);
    if (existing) {
      // Already pointing at the current domain — nothing to do.
      state.nextEligibleAtMs = now.getTime() + STRIPE_SELF_HEAL_OK_INTERVAL_MS;
      return { ran: true, repaired: false, failed: false };
    }
    const created = await sync.findOrCreateManagedWebhook(expectedUrl);
    logger.info(
      { expectedUrl, webhookId: created.id },
      "Stripe webhook self-heal: re-registered managed webhook after domain change",
    );
    state.nextEligibleAtMs = now.getTime() + STRIPE_SELF_HEAL_OK_INTERVAL_MS;
    return { ran: true, repaired: true, failed: false };
  } catch (err) {
    logger.warn(
      { err, expectedUrl },
      "Stripe webhook self-heal: check/repair attempt failed — backing off",
    );
    state.nextEligibleAtMs = now.getTime() + STRIPE_SELF_HEAL_FAILURE_BACKOFF_MS;
    return { ran: true, repaired: false, failed: true };
  }
}

/**
 * Test hook (same pattern as the Twilio self-heal's __configure*ForTests):
 * force-enable/disable, inject fake deps, and reset the throttle window.
 */
export function __configureStripeSelfHealForTests(opts: {
  enabled?: boolean;
  deps?: Partial<StripeSelfHealDeps>;
  resetThrottle?: boolean;
}): void {
  if (opts.enabled !== undefined) state.enabled = opts.enabled;
  if (opts.deps) state.deps = { ...defaultDeps, ...opts.deps };
  if (opts.resetThrottle) state.nextEligibleAtMs = 0;
}

/** Test hook: restore defaults so suites don't leak state into each other. */
export function __resetStripeSelfHealForTests(): void {
  state.enabled = process.env.NODE_ENV !== "test";
  state.deps = defaultDeps;
  state.nextEligibleAtMs = 0;
}
