import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Guards against a cross-site login cookie regression.
//
// The production frontend (getnextinline.com) and the API (*.replit.app) are
// different sites, so the session cookie MUST be issued with SameSite=None;
// Secure in HTTPS/production mode — otherwise browsers silently drop it on
// cross-site fetches and logins fail while same-site tests keep passing.
// In plain-HTTP local dev the cookie must fall back to SameSite=Lax (and not
// Secure), since browsers reject SameSite=None without Secure.
//
// `isHttps` is computed in app.ts at module load time from
// REPLIT_DEV_DOMAIN / NODE_ENV, so each scenario resets modules and imports
// the app fresh with the environment prepared.
// ---------------------------------------------------------------------------

// Mock @workspace/db so the app can be imported without a real database.
vi.mock("@workspace/db", () => ({
  db: {},
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

async function login(app: import("express").Express, opts: { https: boolean }) {
  let req = request(app)
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD });
  if (opts.https) {
    // app.ts sets `trust proxy`, so this makes express-session treat the
    // connection as HTTPS (like Replit's reverse proxy does in production).
    req = req.set("X-Forwarded-Proto", "https");
  }
  return req;
}

describe("session cookie SameSite/Secure attributes", () => {
  beforeEach(() => {
    delete process.env.REPLIT_DEV_DOMAIN;
    process.env.NODE_ENV = "test";
  });

  it("uses SameSite=None; Secure in HTTPS/production-like mode (isHttps true)", async () => {
    process.env.NODE_ENV = "production";
    const app = await loadApp();

    const res = await login(app, { https: true });
    expect(res.status).toBe(200);

    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const sessionCookie = ([] as string[])
      .concat(setCookie as unknown as string[])
      .find((c) => c.startsWith("gnil.sid="));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/;\s*SameSite=None/i);
    expect(sessionCookie).toMatch(/;\s*Secure/i);
    expect(sessionCookie).toMatch(/;\s*HttpOnly/i);
  });

  it("uses SameSite=None; Secure when running on Replit (REPLIT_DEV_DOMAIN set)", async () => {
    process.env.REPLIT_DEV_DOMAIN = "example.repl.dev";
    const app = await loadApp();

    const res = await login(app, { https: true });
    expect(res.status).toBe(200);

    const sessionCookie = ([] as string[])
      .concat(res.headers["set-cookie"] as unknown as string[])
      .find((c) => c.startsWith("gnil.sid="));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/;\s*SameSite=None/i);
    expect(sessionCookie).toMatch(/;\s*Secure/i);
  });

  it("falls back to SameSite=Lax without Secure in plain-HTTP local dev", async () => {
    const app = await loadApp();

    const res = await login(app, { https: false });
    expect(res.status).toBe(200);

    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const sessionCookie = ([] as string[])
      .concat(setCookie as unknown as string[])
      .find((c) => c.startsWith("gnil.sid="));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/;\s*SameSite=Lax/i);
    expect(sessionCookie).not.toMatch(/;\s*Secure/i);
  });
});
