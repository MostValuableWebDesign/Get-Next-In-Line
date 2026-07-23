/**
 * Regression guard for the two Twilio webhook session-auth exemptions.
 *
 * The webhook paths bypass requireAuth so Twilio can call them, relying on
 * X-Twilio-Signature validation inside the handlers. These tests fail if:
 *  (a) the exemption list ever grows beyond the two webhook paths, or
 *  (b) the webhooks stop rejecting requests with a missing/invalid signature.
 */

// Set a fake Twilio auth token BEFORE the app is imported so the webhook
// handlers take the signature-validation path (not the 503 "not configured"
// path). The token is only used to verify signatures; nothing is sent.
process.env.TWILIO_AUTH_TOKEN ??= "test-only-fake-auth-token";
// Ensure the connector proxy lookup is skipped so the env token is used.
delete process.env.REPLIT_CONNECTORS_HOSTNAME;

import { describe, it, expect } from "vitest";
import request from "supertest";
import twilio from "twilio";
import app from "../app";
import { SESSION_EXEMPT_PATHS } from "../routes/index";

const WEBHOOK_PATHS = ["/sos/twilio/inbound", "/sos/twilio/status"];

describe("session-auth exemption list", () => {
  it("contains exactly the two Twilio webhook paths and nothing else", () => {
    expect([...SESSION_EXEMPT_PATHS].sort()).toEqual([...WEBHOOK_PATHS].sort());
  });

  it("non-exempt SOS paths still require a session", async () => {
    // A sibling path under /sos/twilio must NOT be exempt.
    const res = await request(app).post("/api/sos/twilio/other").send({});
    expect(res.status).toBe(401);
    const dash = await request(app).get("/api/sos/dashboard");
    expect(dash.status).toBe(401);
  });
});

describe("Twilio webhook signature validation", () => {
  for (const path of WEBHOOK_PATHS) {
    const url = `/api${path}`;

    it(`POST ${url} without a signature is rejected (not 401 — session exempt)`, async () => {
      const res = await request(app)
        .post(url)
        .type("form")
        .send({ From: "+15550001111", Body: "hi", MessageSid: "SMfake", MessageStatus: "delivered" });
      // Must be rejected by signature validation (403), never let through,
      // and never bounced by session auth (401) since Twilio has no session.
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: "Invalid Twilio signature" });
    });

    it(`POST ${url} with an invalid signature is rejected`, async () => {
      const res = await request(app)
        .post(url)
        .type("form")
        .set("X-Twilio-Signature", "obviously-not-a-valid-signature")
        .send({ From: "+15550001111", Body: "hi", MessageSid: "SMfake", MessageStatus: "delivered" });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: "Invalid Twilio signature" });
    });

    it(`POST ${url} with a signature computed under the wrong token is rejected`, async () => {
      // Sign exactly the URL/params the handler will validate, but with a
      // different auth token — validateRequest must reject it.
      const fullUrl = `http://127.0.0.1${url}`;
      const params = { From: "+15550001111", Body: "hi" };
      const signature = twilio.getExpectedTwilioSignature("wrong-token", fullUrl, params);
      const res = await request(app)
        .post(url)
        .type("form")
        .set("Host", "127.0.0.1")
        .set("X-Twilio-Signature", signature)
        .send(params);
      expect(res.status).toBe(403);
    });
  }
});
