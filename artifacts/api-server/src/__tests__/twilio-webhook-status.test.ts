import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import app from "../app";
import { getTwilioWebhookStatus } from "../lib/sms";
import { getInboundWebhookUrl, getInboundVoiceWebhookUrl } from "../lib/inboundSms";

/**
 * GET /sos/twilio/webhook-status — the live "is Twilio actually pointed at
 * our inbound webhook?" check surfaced on the Settings page.
 *
 * These tests exercise the route contract (auth, tenant scoping, response
 * shape) and the lib's environment-driven failure modes. They never call
 * Twilio's API: in the test environment no Twilio credentials are configured,
 * so the check short-circuits before any network request.
 */

const STATUSES = [
  "configured",
  "misconfigured",
  "no_credentials",
  "no_public_url",
  "no_number",
  "number_not_found",
  "error",
];

describe("getTwilioWebhookStatus (lib)", () => {
  it("reports no_public_url when the app has no public domain", async () => {
    const savedDomains = process.env.REPLIT_DOMAINS;
    const savedDev = process.env.REPLIT_DEV_DOMAIN;
    delete process.env.REPLIT_DOMAINS;
    delete process.env.REPLIT_DEV_DOMAIN;
    try {
      const res = await getTwilioWebhookStatus(null);
      expect(res.status).toBe("no_public_url");
      expect(res.expectedUrl).toBeNull();
      expect(res.configuredUrl).toBeNull();
      // Precondition failures apply to the voice check identically.
      expect(res.voiceStatus).toBe("no_public_url");
      expect(res.expectedVoiceUrl).toBeNull();
      expect(res.configuredVoiceUrl).toBeNull();
    } finally {
      if (savedDomains != null) process.env.REPLIT_DOMAINS = savedDomains;
      if (savedDev != null) process.env.REPLIT_DEV_DOMAIN = savedDev;
    }
  });

  it("always reports the expected URLs when a public domain exists", async () => {
    const expected = getInboundWebhookUrl();
    expect(expected).toMatch(/^https:\/\/.+\/api\/sos\/twilio\/inbound$/);
    const expectedVoice = getInboundVoiceWebhookUrl();
    expect(expectedVoice).toMatch(/^https:\/\/.+\/api\/sos\/twilio\/voice$/);
    const res = await getTwilioWebhookStatus(null);
    expect(res.expectedUrl).toBe(expected);
    expect(res.expectedVoiceUrl).toBe(expectedVoice);
    expect(STATUSES).toContain(res.status);
    expect(STATUSES).toContain(res.voiceStatus);
  });
});

describe("GET /api/sos/twilio/webhook-status (route)", () => {
  let cookie: string;

  beforeAll(async () => {
    const adminPassword = process.env.ADMIN_PASSWORD;
    expect(adminPassword, "ADMIN_PASSWORD must be set to run auth tests").toBeTruthy();
    const login = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-Proto", "https")
      .send({ password: adminPassword });
    expect(login.status).toBe(200);
    const setCookie = login.headers["set-cookie"];
    cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .map((c: string) => c.split(";")[0])
      .join("; ");
  });

  it("requires a session", async () => {
    const res = await request(app).get("/api/sos/twilio/webhook-status");
    expect(res.status).toBe(401);
  });

  it("requires explicit tenant scope like every other SOS route", async () => {
    const res = await request(app)
      .get("/api/sos/twilio/webhook-status")
      .set("Cookie", cookie);
    expect(res.status).toBe(400);
  });

  it("returns the check result for the legacy scope", async () => {
    const res = await request(app)
      .get("/api/sos/twilio/webhook-status")
      .set("Cookie", cookie)
      .set("x-tenant-id", "legacy");
    expect(res.status).toBe(200);
    expect(STATUSES).toContain(res.body.status);
    expect(res.body).toHaveProperty("phoneNumber");
    expect(res.body).toHaveProperty("expectedUrl");
    expect(res.body).toHaveProperty("configuredUrl");
    expect(res.body).toHaveProperty("errorMessage");
    expect(STATUSES).toContain(res.body.voiceStatus);
    expect(res.body).toHaveProperty("configuredVoiceUrl");
    // A public domain exists in this environment, so the expected URLs must
    // be surfaced regardless of whether Twilio credentials are connected.
    expect(res.body.expectedUrl).toBe(getInboundWebhookUrl());
    expect(res.body.expectedVoiceUrl).toBe(getInboundVoiceWebhookUrl());
  });
});
