import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import app from "../app";

/**
 * Regression guard: SOS endpoints expose customer data and must stay behind
 * session auth. If a route reshuffle ever mounts the SOS router before the
 * requireAuth middleware again, these tests fail.
 */

const PROTECTED_ENDPOINTS = [
  "/api/sos/dashboard",
  "/api/sos/customers",
  "/api/sos/visits",
  "/api/sos/settings",
  "/api/sos/resources",
  "/api/sos/appointments",
  "/api/sos/waitlist",
  "/api/sos/messages",
];

describe("SOS API auth guard", () => {
  describe("without a session", () => {
    for (const path of PROTECTED_ENDPOINTS) {
      it(`GET ${path} returns 401`, async () => {
        const res = await request(app).get(path);
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ error: "Unauthorized" });
      });
    }

    it("POST /api/sos/customers returns 401 (no writes without auth)", async () => {
      const res = await request(app)
        .post("/api/sos/customers")
        .send({ name: "Intruder", phone: "+15550000000" });
      expect(res.status).toBe(401);
    });
  });

  describe("with a valid session", () => {
    let cookie: string;

    beforeAll(async () => {
      const adminPassword = process.env.ADMIN_PASSWORD;
      expect(adminPassword, "ADMIN_PASSWORD must be set to run auth tests").toBeTruthy();
      // The session cookie is Secure; `trust proxy` makes express-session
      // treat the request as HTTPS when X-Forwarded-Proto says so.
      const login = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-Proto", "https")
        .send({ password: adminPassword });
      expect(login.status).toBe(200);
      const setCookie = login.headers["set-cookie"];
      expect(setCookie).toBeTruthy();
      // Send the raw session cookie manually so the Secure flag doesn't
      // stop superagent from replaying it over plain HTTP in tests.
      cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
        .map((c: string) => c.split(";")[0])
        .join("; ");
    });

    it("rejects a bad password with 401 and no cookie", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ password: "not-the-password" });
      expect(res.status).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("GET /api/sos/dashboard succeeds", async () => {
      const res = await request(app)
        .get("/api/sos/dashboard")
        .set("Cookie", cookie)
        .set("x-tenant-id", "legacy");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("inQueue");
    });

    it("GET /api/sos/customers succeeds", async () => {
      const res = await request(app)
        .get("/api/sos/customers")
        .set("Cookie", cookie)
        .set("x-tenant-id", "legacy");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("GET /api/sos/visits succeeds", async () => {
      const res = await request(app)
        .get("/api/sos/visits")
        .set("Cookie", cookie)
        .set("x-tenant-id", "legacy");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});
