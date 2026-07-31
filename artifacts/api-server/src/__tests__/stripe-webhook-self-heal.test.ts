import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runStripeWebhookSelfHeal,
  __configureStripeSelfHealForTests,
  __resetStripeSelfHealForTests,
  currentStripeWebhookUrl,
  STRIPE_SELF_HEAL_OK_INTERVAL_MS,
  STRIPE_SELF_HEAL_FAILURE_BACKOFF_MS,
  type StripeSelfHealSync,
} from "../lib/stripeWebhookSelfHeal";

/**
 * Stripe managed-webhook domain-drift self-heal: after a domain change, the
 * concierge-tick backstop must detect that no managed webhook exists at the
 * current domain's URL and re-register it — never in test mode, never when
 * Stripe isn't configured or no public domain is known, and with an
 * hours-scale backoff when the check/repair keeps failing.
 */

const EXPECTED_URL = "https://new-domain.example.com/api/stripe/webhook";

function makeSync(overrides: Partial<StripeSelfHealSync> = {}): StripeSelfHealSync {
  return {
    getManagedWebhookByUrl: vi.fn().mockResolvedValue({ id: "we_1", url: EXPECTED_URL }),
    findOrCreateManagedWebhook: vi.fn().mockResolvedValue({ id: "we_2", url: EXPECTED_URL }),
    ...overrides,
  };
}

beforeEach(() => {
  __resetStripeSelfHealForTests();
});
afterEach(() => {
  __resetStripeSelfHealForTests();
});

describe("currentStripeWebhookUrl", () => {
  it("derives the webhook URL from the first REPLIT_DOMAINS entry at call time", () => {
    const prev = process.env.REPLIT_DOMAINS;
    try {
      process.env.REPLIT_DOMAINS = "a.example.com,b.example.com";
      expect(currentStripeWebhookUrl()).toBe("https://a.example.com/api/stripe/webhook");
      process.env.REPLIT_DOMAINS = "rotated.example.com";
      expect(currentStripeWebhookUrl()).toBe("https://rotated.example.com/api/stripe/webhook");
      delete process.env.REPLIT_DOMAINS;
      expect(currentStripeWebhookUrl()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.REPLIT_DOMAINS;
      else process.env.REPLIT_DOMAINS = prev;
    }
  });
});

describe("runStripeWebhookSelfHeal", () => {
  it("does nothing at all under test mode (no Stripe API traffic)", async () => {
    const sync = makeSync();
    const getSync = vi.fn().mockResolvedValue(sync);
    // Deliberately do NOT enable: NODE_ENV=test keeps the default disabled.
    __configureStripeSelfHealForTests({
      deps: { getSync, isConfigured: () => true, getExpectedUrl: () => EXPECTED_URL },
    });
    const res = await runStripeWebhookSelfHeal();
    expect(res.ran).toBe(false);
    expect(getSync).not.toHaveBeenCalled();
  });

  it("skips without consuming the throttle when Stripe isn't configured", async () => {
    const getSync = vi.fn();
    __configureStripeSelfHealForTests({
      enabled: true,
      deps: { getSync, isConfigured: () => false, getExpectedUrl: () => EXPECTED_URL },
    });
    expect((await runStripeWebhookSelfHeal()).ran).toBe(false);
    expect(getSync).not.toHaveBeenCalled();
    // Becomes configured later: still eligible immediately.
    __configureStripeSelfHealForTests({
      deps: { getSync: vi.fn().mockResolvedValue(makeSync()), isConfigured: () => true, getExpectedUrl: () => EXPECTED_URL },
    });
    expect((await runStripeWebhookSelfHeal()).ran).toBe(true);
  });

  it("skips when no public domain is known", async () => {
    const getSync = vi.fn();
    __configureStripeSelfHealForTests({
      enabled: true,
      deps: { getSync, isConfigured: () => true, getExpectedUrl: () => null },
    });
    expect((await runStripeWebhookSelfHeal()).ran).toBe(false);
    expect(getSync).not.toHaveBeenCalled();
  });

  it("makes no re-register call when the webhook already points at the current domain", async () => {
    const sync = makeSync();
    __configureStripeSelfHealForTests({
      enabled: true,
      deps: {
        getSync: async () => sync,
        isConfigured: () => true,
        getExpectedUrl: () => EXPECTED_URL,
      },
    });
    const res = await runStripeWebhookSelfHeal();
    expect(res).toEqual({ ran: true, repaired: false, failed: false });
    expect(sync.getManagedWebhookByUrl).toHaveBeenCalledWith(EXPECTED_URL);
    expect(sync.findOrCreateManagedWebhook).not.toHaveBeenCalled();
  });

  it("re-registers the managed webhook when none exists at the current URL (domain drift)", async () => {
    const sync = makeSync({ getManagedWebhookByUrl: vi.fn().mockResolvedValue(null) });
    __configureStripeSelfHealForTests({
      enabled: true,
      deps: {
        getSync: async () => sync,
        isConfigured: () => true,
        getExpectedUrl: () => EXPECTED_URL,
      },
    });
    const res = await runStripeWebhookSelfHeal();
    expect(res).toEqual({ ran: true, repaired: true, failed: false });
    expect(sync.findOrCreateManagedWebhook).toHaveBeenCalledTimes(1);
    expect(sync.findOrCreateManagedWebhook).toHaveBeenCalledWith(EXPECTED_URL);
  });

  it("throttles: a second immediate run is a no-op after a clean pass", async () => {
    const sync = makeSync();
    __configureStripeSelfHealForTests({
      enabled: true,
      deps: {
        getSync: async () => sync,
        isConfigured: () => true,
        getExpectedUrl: () => EXPECTED_URL,
      },
    });
    const t0 = new Date("2026-07-31T10:00:00Z");
    expect((await runStripeWebhookSelfHeal(t0)).ran).toBe(true);
    expect((await runStripeWebhookSelfHeal(t0)).ran).toBe(false);
    const justBefore = new Date(t0.getTime() + STRIPE_SELF_HEAL_OK_INTERVAL_MS - 1000);
    expect((await runStripeWebhookSelfHeal(justBefore)).ran).toBe(false);
    expect(sync.getManagedWebhookByUrl).toHaveBeenCalledTimes(1);
    const after = new Date(t0.getTime() + STRIPE_SELF_HEAL_OK_INTERVAL_MS + 1000);
    expect((await runStripeWebhookSelfHeal(after)).ran).toBe(true);
    expect(sync.getManagedWebhookByUrl).toHaveBeenCalledTimes(2);
  });

  it("backs off after a failure — retries on the order of hours, not every tick", async () => {
    const sync = makeSync({
      getManagedWebhookByUrl: vi.fn().mockRejectedValue(new Error("stripe down")),
    });
    __configureStripeSelfHealForTests({
      enabled: true,
      deps: {
        getSync: async () => sync,
        isConfigured: () => true,
        getExpectedUrl: () => EXPECTED_URL,
      },
    });
    const t0 = new Date("2026-07-31T10:00:00Z");
    const first = await runStripeWebhookSelfHeal(t0);
    expect(first).toEqual({ ran: true, repaired: false, failed: true });

    // Simulated 5-minute concierge ticks during the backoff window: no calls.
    for (let m = 5; m < STRIPE_SELF_HEAL_FAILURE_BACKOFF_MS / 60000; m += 5) {
      expect((await runStripeWebhookSelfHeal(new Date(t0.getTime() + m * 60000))).ran).toBe(false);
    }
    expect(sync.getManagedWebhookByUrl).toHaveBeenCalledTimes(1);

    const retryAt = new Date(t0.getTime() + STRIPE_SELF_HEAL_FAILURE_BACKOFF_MS + 1000);
    expect((await runStripeWebhookSelfHeal(retryAt)).ran).toBe(true);
    expect(sync.getManagedWebhookByUrl).toHaveBeenCalledTimes(2);
  });

  it("never throws even when getSync itself rejects, and backs off", async () => {
    __configureStripeSelfHealForTests({
      enabled: true,
      deps: {
        getSync: vi.fn().mockRejectedValue(new Error("connector unavailable")),
        isConfigured: () => true,
        getExpectedUrl: () => EXPECTED_URL,
      },
    });
    const res = await runStripeWebhookSelfHeal();
    expect(res.ran).toBe(true);
    expect(res.failed).toBe(true);
    expect((await runStripeWebhookSelfHeal()).ran).toBe(false);
  });
});
