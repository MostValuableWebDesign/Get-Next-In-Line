import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import app from "../app";
import { configureTwilioWebhook } from "../lib/sms";

/**
 * POST /sos/twilio/configure-webhook — the Settings page "Fix now" action
 * that points the Twilio number's "A message comes in" webhook at this
 * app's inbound URL, then re-runs the live check.
 *
 * The test environment has no Twilio credentials (the connector proxy is
 * deliberately disabled under NODE_ENV=test), so the fix short-circuits
 * before any network call — these tests exercise the route contract and
 * the graceful-failure shape.
 */

describe("configureTwilioWebhook (lib)", () => {
  it("never throws and reports a graceful error when preconditions are missing", async () => {
    const res = await configureTwilioWebhook(null);
    expect(res.fixed).toBe(false);
    expect(res.check).toBeTruthy();
    // Not misconfigured in the test env → no fix attempted, reason surfaced.
    expect(res.check.status).not.toBe("configured");
    expect(res.errorMessage).toBeTruthy();
  });

  it("handles the voice target the same graceful way", async () => {
    const res = await configureTwilioWebhook(null, "voice");
    expect(res.fixed).toBe(false);
    expect(res.check).toBeTruthy();
    expect(res.check.voiceStatus).not.toBe("configured");
    expect(res.errorMessage).toBeTruthy();
  });
});

describe("POST /api/sos/twilio/configure-webhook (route)", () => {
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
    const res = await request(app).post("/api/sos/twilio/configure-webhook");
    expect(res.status).toBe(401);
  });

  it("requires explicit tenant scope like every other SOS route", async () => {
    const res = await request(app)
      .post("/api/sos/twilio/configure-webhook")
      .set("Cookie", cookie);
    expect(res.status).toBe(400);
  });

  it("returns 200 with a graceful failure result when Twilio isn't connected", async () => {
    const res = await request(app)
      .post("/api/sos/twilio/configure-webhook")
      .set("Cookie", cookie)
      .set("x-tenant-id", "legacy");
    expect(res.status).toBe(200);
    expect(res.body.fixed).toBe(false);
    expect(res.body).toHaveProperty("check");
    expect(res.body.check).toHaveProperty("status");
    expect(res.body.check).toHaveProperty("voiceStatus");
    expect(res.body).toHaveProperty("errorMessage");
  });

  it("accepts an explicit voice target in the body", async () => {
    const res = await request(app)
      .post("/api/sos/twilio/configure-webhook")
      .set("Cookie", cookie)
      .set("x-tenant-id", "legacy")
      .send({ target: "voice" });
    expect(res.status).toBe(200);
    expect(res.body.fixed).toBe(false);
    expect(res.body.check).toHaveProperty("voiceStatus");
  });

  it("rejects an invalid target", async () => {
    const res = await request(app)
      .post("/api/sos/twilio/configure-webhook")
      .set("Cookie", cookie)
      .set("x-tenant-id", "legacy")
      .send({ target: "fax" });
    expect(res.status).toBe(400);
  });
});
