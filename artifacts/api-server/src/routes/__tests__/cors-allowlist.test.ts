import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Guards against a CORS allowlist regression.
//
// Cross-site logins from the marketing domain depend on the API's CORS
// allowlist permitting https://getnextinline.com and
// https://www.getnextinline.com with credentials. If ALLOWED_ORIGINS handling
// or the built-in defaults regress, browser logins from those origins fail
// with a CORS error while all same-origin tests keep passing.
//
// The allowlist is computed in app.ts at module load time from
// ALLOWED_ORIGINS / REPLIT_DOMAINS, so each scenario resets modules and
// imports the app fresh with the environment prepared.
// ---------------------------------------------------------------------------

// Mock @workspace/db so the app can be imported without a real database.
vi.mock("@workspace/db", () => ({
  db: {},
  pool: undefined,
  modulesTable: {},
  agencySettingsTable: {},
  tenantsTable: {},
  tenantModulesTable: {},
  tenantActivitiesTable: {},
}));

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

async function loadApp(): Promise<import("express").Express> {
  vi.resetModules();
  return (await import("../../app")).default;
}

async function loadLoggerWarnSpy() {
  // Must be called after vi.resetModules() (i.e. right before loadApp's
  // dynamic import re-evaluates app.ts) so the spy attaches to the same
  // logger instance the freshly-loaded app module uses.
  const { logger } = await import("../../lib/logger");
  return vi.spyOn(logger, "warn");
}

describe("CORS allowlist for cross-site logins", () => {
  beforeEach(() => {
    delete process.env.REPLIT_DEV_DOMAIN;
    delete process.env.ALLOWED_ORIGINS;
    process.env.NODE_ENV = "test";
  });

  for (const origin of [
    "https://getnextinline.com",
    "https://www.getnextinline.com",
  ]) {
    it(`allows credentialed requests from ${origin} by default`, async () => {
      const app = await loadApp();

      const res = await request(app)
        .post("/api/auth/login")
        .set("Origin", origin)
        .send({ password: process.env.ADMIN_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });

    it(`handles the preflight OPTIONS request from ${origin}`, async () => {
      const app = await loadApp();

      const res = await request(app)
        .options("/api/auth/login")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "content-type");

      expect(res.status).toBeLessThan(300);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });
  }

  it("rejects requests from a disallowed origin", async () => {
    const app = await loadApp();

    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "https://evil.example.com")
      .send({ password: process.env.ADMIN_PASSWORD });

    // The cors middleware calls back with an error, which app.ts maps to a
    // deliberate 403 — and crucially, no CORS headers are emitted, so the
    // browser blocks the response. This also stops cross-site form POSTs
    // (which skip preflight) from reaching cookie-authenticated handlers.
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("keeps the getnextinline.com defaults even when ALLOWED_ORIGINS is overridden without them", async () => {
    // Documents the current contract: ALLOWED_ORIGINS *replaces* the
    // defaults. If someone sets it without the marketing domains, logins
    // from getnextinline.com would break — this test makes that explicit.
    process.env.ALLOWED_ORIGINS = "https://other.example.com";
    const app = await loadApp();

    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "https://other.example.com")
      .send({ password: process.env.ADMIN_PASSWORD });

    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://other.example.com",
    );

    const resDefault = await request(app)
      .post("/api/auth/login")
      .set("Origin", "https://getnextinline.com")
      .send({ password: process.env.ADMIN_PASSWORD });

    // Overriding ALLOWED_ORIGINS drops the defaults.
    expect(
      resDefault.headers["access-control-allow-origin"],
    ).toBeUndefined();
  });

  it("warns loudly at startup when ALLOWED_ORIGINS omits the getnextinline.com origins", async () => {
    process.env.ALLOWED_ORIGINS = "https://other.example.com";

    vi.resetModules();
    const warnSpy = await loadLoggerWarnSpy();
    await import("../../app");

    const warning = warnSpy.mock.calls.find(
      (call) =>
        typeof call[1] === "string" && call[1].includes("ALLOWED_ORIGINS"),
    );
    expect(warning).toBeDefined();
    expect(warning![1]).toContain("getnextinline.com");
    expect(warning![0]).toMatchObject({
      missingOrigins: expect.arrayContaining([
        "https://getnextinline.com",
        "https://www.getnextinline.com",
      ]),
    });

    warnSpy.mockRestore();
  });

  it("does not warn when ALLOWED_ORIGINS includes the getnextinline.com origins", async () => {
    process.env.ALLOWED_ORIGINS =
      "https://www.getnextinline.com,https://getnextinline.com,https://other.example.com";

    vi.resetModules();
    const warnSpy = await loadLoggerWarnSpy();
    await import("../../app");

    const warning = warnSpy.mock.calls.find(
      (call) =>
        typeof call[1] === "string" && call[1].includes("ALLOWED_ORIGINS"),
    );
    expect(warning).toBeUndefined();

    warnSpy.mockRestore();
  });

  it("does not warn when ALLOWED_ORIGINS is unset", async () => {
    vi.resetModules();
    const warnSpy = await loadLoggerWarnSpy();
    await import("../../app");

    const warning = warnSpy.mock.calls.find(
      (call) =>
        typeof call[1] === "string" && call[1].includes("ALLOWED_ORIGINS"),
    );
    expect(warning).toBeUndefined();

    warnSpy.mockRestore();
  });
});
