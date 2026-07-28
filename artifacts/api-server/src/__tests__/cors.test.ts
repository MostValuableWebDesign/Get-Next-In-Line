import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

describe("CORS allowlist", () => {
  const allowed = [
    "https://www.getnextinline.com",
    "https://getnextinline.com",
  ];

  for (const origin of allowed) {
    it(`allows ${origin} with credentials`, async () => {
      const res = await request(app)
        .get("/api/healthz")
        .set("Origin", origin);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });
  }

  it("allows localhost dev origin in non-production", async () => {
    const origin = "http://localhost:5173";
    const res = await request(app).get("/api/healthz").set("Origin", origin);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
  });

  it("rejects a disallowed origin", async () => {
    const res = await request(app)
      .get("/api/healthz")
      .set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    // The CORS allowlist error is mapped to a deliberate 403 in app.ts.
    expect(res.status).toBe(403);
  });

  it("allows requests without an Origin header", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBeLessThan(500);
  });
});
