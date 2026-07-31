import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runTwilioWebhookSelfHeal,
  __configureTwilioSelfHealForTests,
  __resetTwilioSelfHealForTests,
  SELF_HEAL_OK_INTERVAL_MS,
  SELF_HEAL_FAILURE_BACKOFF_MS,
} from "../lib/twilioWebhookSelfHeal";
import type { TwilioWebhookCheck, TwilioWebhookConfigureResult } from "../lib/sms";

/**
 * Twilio webhook domain-drift self-heal: after a domain change, the startup
 * pass / concierge-tick backstop must detect a misconfigured inbound webhook
 * and repair it via the existing auto-configure — exactly once per target,
 * never when already configured, never in test/simulated mode, and with an
 * hours-scale backoff when a repair keeps failing.
 */

function makeCheck(overrides: Partial<TwilioWebhookCheck> = {}): TwilioWebhookCheck {
  return {
    status: "configured",
    phoneNumber: "+15551234567",
    expectedUrl: "https://app.example.com/api/twilio/inbound",
    configuredUrl: "https://app.example.com/api/twilio/inbound",
    voiceStatus: "configured",
    expectedVoiceUrl: "https://app.example.com/api/twilio/voice",
    configuredVoiceUrl: "https://app.example.com/api/twilio/voice",
    errorMessage: null,
    ...overrides,
  };
}

function makeConfigureResult(
  fixed: boolean,
  check: TwilioWebhookCheck,
): TwilioWebhookConfigureResult {
  return { fixed, check, errorMessage: fixed ? null : "insufficient token permissions" };
}

beforeEach(() => {
  __resetTwilioSelfHealForTests();
});
afterEach(() => {
  __resetTwilioSelfHealForTests();
});

describe("runTwilioWebhookSelfHeal", () => {
  it("does nothing at all under test mode (simulated transport untouched)", async () => {
    const getStatus = vi.fn();
    const configure = vi.fn();
    // Deliberately do NOT enable: NODE_ENV=test keeps the default disabled.
    __configureTwilioSelfHealForTests({ deps: { getStatus, configure } });
    const res = await runTwilioWebhookSelfHeal();
    expect(res.ran).toBe(false);
    expect(getStatus).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
  });

  it("makes no configure calls when both webhooks are already configured", async () => {
    const getStatus = vi.fn().mockResolvedValue(makeCheck());
    const configure = vi.fn();
    __configureTwilioSelfHealForTests({ enabled: true, deps: { getStatus, configure } });
    const res = await runTwilioWebhookSelfHeal();
    expect(res.ran).toBe(true);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(configure).not.toHaveBeenCalled();
    expect(res.repaired).toEqual([]);
    expect(res.failed).toEqual([]);
  });

  it("makes no configure calls on precondition statuses (no creds / no public URL)", async () => {
    for (const status of ["no_credentials", "no_public_url", "no_number", "error"] as const) {
      __resetTwilioSelfHealForTests();
      const getStatus = vi
        .fn()
        .mockResolvedValue(makeCheck({ status, voiceStatus: status, configuredUrl: null }));
      const configure = vi.fn();
      __configureTwilioSelfHealForTests({ enabled: true, deps: { getStatus, configure } });
      await runTwilioWebhookSelfHeal();
      expect(configure, status).not.toHaveBeenCalled();
    }
  });

  it("repairs a misconfigured target with exactly one configure call per target", async () => {
    const check = makeCheck({
      status: "misconfigured",
      configuredUrl: "https://old-domain.example.com/api/twilio/inbound",
      voiceStatus: "misconfigured",
      configuredVoiceUrl: "https://old-domain.example.com/api/twilio/voice",
    });
    const getStatus = vi.fn().mockResolvedValue(check);
    const configure = vi
      .fn()
      .mockImplementation(async () => makeConfigureResult(true, makeCheck()));
    __configureTwilioSelfHealForTests({ enabled: true, deps: { getStatus, configure } });

    const res = await runTwilioWebhookSelfHeal();
    expect(res.ran).toBe(true);
    expect(configure).toHaveBeenCalledTimes(2);
    expect(configure).toHaveBeenCalledWith(null, "sms");
    expect(configure).toHaveBeenCalledWith(null, "voice");
    expect(res.repaired).toEqual(["sms", "voice"]);
    expect(res.failed).toEqual([]);
  });

  it("repairs only the drifted target when the other is fine", async () => {
    const check = makeCheck({
      status: "misconfigured",
      configuredUrl: "https://old-domain.example.com/api/twilio/inbound",
    });
    const getStatus = vi.fn().mockResolvedValue(check);
    const configure = vi
      .fn()
      .mockImplementation(async () => makeConfigureResult(true, makeCheck()));
    __configureTwilioSelfHealForTests({ enabled: true, deps: { getStatus, configure } });

    const res = await runTwilioWebhookSelfHeal();
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith(null, "sms");
    expect(res.repaired).toEqual(["sms"]);
  });

  it("skips a misconfigured target with no expected URL (nothing to point at)", async () => {
    const check = makeCheck({ status: "misconfigured", expectedUrl: null });
    const getStatus = vi.fn().mockResolvedValue(check);
    const configure = vi.fn();
    __configureTwilioSelfHealForTests({ enabled: true, deps: { getStatus, configure } });
    await runTwilioWebhookSelfHeal();
    expect(configure).not.toHaveBeenCalled();
  });

  it("throttles: a second immediate run is a no-op after a clean pass", async () => {
    const getStatus = vi.fn().mockResolvedValue(makeCheck());
    const configure = vi.fn();
    __configureTwilioSelfHealForTests({ enabled: true, deps: { getStatus, configure } });

    const t0 = new Date("2026-07-31T10:00:00Z");
    expect((await runTwilioWebhookSelfHeal(t0)).ran).toBe(true);
    // Immediately after, and just before the OK interval elapses: skipped.
    expect((await runTwilioWebhookSelfHeal(t0)).ran).toBe(false);
    const justBefore = new Date(t0.getTime() + SELF_HEAL_OK_INTERVAL_MS - 1000);
    expect((await runTwilioWebhookSelfHeal(justBefore)).ran).toBe(false);
    expect(getStatus).toHaveBeenCalledTimes(1);
    // After the interval: runs again.
    const after = new Date(t0.getTime() + SELF_HEAL_OK_INTERVAL_MS + 1000);
    expect((await runTwilioWebhookSelfHeal(after)).ran).toBe(true);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("backs off after a failed repair — retries on the order of hours, not every tick", async () => {
    const check = makeCheck({
      status: "misconfigured",
      configuredUrl: "https://old-domain.example.com/api/twilio/inbound",
    });
    const getStatus = vi.fn().mockResolvedValue(check);
    const configure = vi
      .fn()
      .mockImplementation(async () => makeConfigureResult(false, check));
    __configureTwilioSelfHealForTests({ enabled: true, deps: { getStatus, configure } });

    const t0 = new Date("2026-07-31T10:00:00Z");
    const first = await runTwilioWebhookSelfHeal(t0);
    expect(first.ran).toBe(true);
    expect(first.failed).toEqual(["sms"]);
    expect(configure).toHaveBeenCalledTimes(1);

    // Simulated 5-minute concierge ticks during the backoff window: no calls.
    for (let m = 5; m < SELF_HEAL_FAILURE_BACKOFF_MS / 60000; m += 5) {
      const res = await runTwilioWebhookSelfHeal(new Date(t0.getTime() + m * 60000));
      expect(res.ran).toBe(false);
    }
    expect(configure).toHaveBeenCalledTimes(1);

    // After the backoff elapses, exactly one more attempt.
    const retryAt = new Date(t0.getTime() + SELF_HEAL_FAILURE_BACKOFF_MS + 1000);
    expect((await runTwilioWebhookSelfHeal(retryAt)).ran).toBe(true);
    expect(configure).toHaveBeenCalledTimes(2);
  });

  it("backs off after an errored status check too", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValue(makeCheck({ status: "error", voiceStatus: "error", errorMessage: "boom" }));
    const configure = vi.fn();
    __configureTwilioSelfHealForTests({ enabled: true, deps: { getStatus, configure } });

    const t0 = new Date("2026-07-31T10:00:00Z");
    await runTwilioWebhookSelfHeal(t0);
    const beforeBackoff = new Date(t0.getTime() + SELF_HEAL_FAILURE_BACKOFF_MS - 1000);
    expect((await runTwilioWebhookSelfHeal(beforeBackoff)).ran).toBe(false);
    const afterBackoff = new Date(t0.getTime() + SELF_HEAL_FAILURE_BACKOFF_MS + 1000);
    expect((await runTwilioWebhookSelfHeal(afterBackoff)).ran).toBe(true);
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(configure).not.toHaveBeenCalled();
  });

  it("never throws even when the injected deps throw", async () => {
    const getStatus = vi.fn().mockRejectedValue(new Error("network down"));
    const configure = vi.fn();
    __configureTwilioSelfHealForTests({ enabled: true, deps: { getStatus, configure } });
    const res = await runTwilioWebhookSelfHeal();
    expect(res.ran).toBe(true);
    expect(res.repaired).toEqual([]);
    // And it backed off: an immediate retry is throttled.
    expect((await runTwilioWebhookSelfHeal()).ran).toBe(false);
  });
});
