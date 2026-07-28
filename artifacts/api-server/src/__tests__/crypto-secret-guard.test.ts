import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Regression guard: the at-rest encryption helpers (partner credential
 * tokens, safety incident text) must refuse to derive keys from the
 * hardcoded dev fallback in production. A missing SESSION_SECRET means the
 * affected feature clearly refuses to run instead of silently encrypting
 * real data under a key anyone can derive from the source. Outside
 * production the fallback (plus a warning) stays allowed.
 */

describe("encryption secret production fail-fast", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("partner crypto refuses to encrypt in production without SESSION_SECRET", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.SESSION_SECRET;
    const { encryptToken } = await import("../lib/partnerCrypto");
    expect(() => encryptToken("tok_secret")).toThrow(/SESSION_SECRET/);
  });

  it("safety crypto refuses to encrypt in production without SESSION_SECRET", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.SESSION_SECRET;
    const { encryptIncidentText } = await import("../lib/safetyCrypto");
    expect(() => encryptIncidentText("sensitive")).toThrow(/SESSION_SECRET/);
  });

  it("both work in production when SESSION_SECRET is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "a-real-secret-for-this-test");
    const { encryptToken, decryptToken } = await import("../lib/partnerCrypto");
    const { encryptIncidentText, decryptIncidentText } = await import("../lib/safetyCrypto");
    expect(decryptToken(encryptToken("tok_secret"))).toBe("tok_secret");
    expect(decryptIncidentText(encryptIncidentText("sensitive"))).toBe("sensitive");
  });

  it("falls back (with warning) outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.SESSION_SECRET;
    const { encryptToken, decryptToken } = await import("../lib/partnerCrypto");
    expect(decryptToken(encryptToken("tok_secret"))).toBe("tok_secret");
  });
});
