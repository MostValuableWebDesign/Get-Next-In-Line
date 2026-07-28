import { describe, it, expect } from "vitest";
import {
  evaluateStartupConfig,
  formatStartupConfigSummary,
  isOpenAiConfigured,
} from "../startupConfig";

// ---------------------------------------------------------------------------
// Startup config report: one summary of which optional integrations are live
// vs simulated. Probes are injected so the logic is tested without touching
// real connectors, and a throwing probe must degrade to "simulated" instead
// of breaking startup.
// ---------------------------------------------------------------------------

const openaiEnv = {
  AI_INTEGRATIONS_OPENAI_BASE_URL: "https://proxy.example",
  AI_INTEGRATIONS_OPENAI_API_KEY: "key",
} as NodeJS.ProcessEnv;

describe("evaluateStartupConfig", () => {
  it("reports every service live when all probes succeed", async () => {
    const services = await evaluateStartupConfig({
      stripeConfigured: async () => true,
      smsMode: async () => "live",
      emailMode: async () => "live",
      env: openaiEnv,
    });
    expect(services.map((s) => [s.service, s.mode])).toEqual([
      ["stripe", "live"],
      ["sms", "live"],
      ["email", "live"],
      ["openai", "live"],
    ]);
    expect(formatStartupConfigSummary(services)).toBe(
      "stripe=live sms=live email=live openai=live",
    );
  });

  it("reports simulated modes when credentials are absent", async () => {
    const services = await evaluateStartupConfig({
      stripeConfigured: async () => false,
      smsMode: async () => "simulated",
      emailMode: async () => "simulated",
      env: {} as NodeJS.ProcessEnv,
    });
    for (const s of services) {
      expect(s.mode).toBe("simulated");
      expect(s.detail).toBeTruthy();
    }
  });

  it("degrades a throwing probe to simulated with the error in the detail", async () => {
    const services = await evaluateStartupConfig({
      stripeConfigured: async () => {
        throw new Error("connector proxy unreachable");
      },
      smsMode: async () => "live",
      emailMode: async () => "live",
      env: openaiEnv,
    });
    const stripe = services.find((s) => s.service === "stripe")!;
    expect(stripe.mode).toBe("simulated");
    expect(stripe.detail).toMatch(/connector proxy unreachable/);
    // Other probes are unaffected.
    expect(services.find((s) => s.service === "sms")!.mode).toBe("live");
  });
});

describe("isOpenAiConfigured", () => {
  it("requires both base URL and API key", () => {
    expect(isOpenAiConfigured(openaiEnv)).toBe(true);
    expect(
      isOpenAiConfigured({
        AI_INTEGRATIONS_OPENAI_BASE_URL: "https://proxy.example",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(isOpenAiConfigured({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
