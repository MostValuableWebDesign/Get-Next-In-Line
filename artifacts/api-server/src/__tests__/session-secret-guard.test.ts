import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Regression guard: the server must refuse to boot in production without a
 * real SESSION_SECRET. Signing session cookies with the hardcoded dev
 * fallback in production would let anyone who reads the source forge
 * sessions. In development/test the fallback (plus a warning) stays allowed
 * so local runs and this suite keep working.
 *
 * app.ts runs the guard at module load, so each case re-imports a fresh
 * copy of the module graph under stubbed env vars.
 */

describe("SESSION_SECRET production fail-fast", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses to initialize in production without SESSION_SECRET", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    // stubEnv("", ...) leaves an empty string; make it truly unset.
    delete process.env.SESSION_SECRET;

    await expect(import("../app")).rejects.toThrow(
      /SESSION_SECRET.*refuses to start in production/s,
    );
  });

  it("initializes in production when SESSION_SECRET is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "a-real-secret-for-this-test");

    const mod = await import("../app");
    expect(mod.default).toBeTypeOf("function");
  });

  it("still initializes without SESSION_SECRET outside production (fallback + warning)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SESSION_SECRET", "");
    delete process.env.SESSION_SECRET;

    const mod = await import("../app");
    expect(mod.default).toBeTypeOf("function");
  });
});
