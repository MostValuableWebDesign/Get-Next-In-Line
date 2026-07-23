import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

/**
 * Regression guard: every agency/tenant/billing/module endpoint must stay
 * behind session auth. These endpoints expose tenant PII, billing data, and
 * destructive mutations — if a route reshuffle ever mounts one of these
 * routers before the requireAuth middleware, these tests fail.
 */

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const PROTECTED_READS = [
  "/api/agency/dashboard",
  "/api/agency/settings",
  "/api/tenants",
  `/api/tenants/${NIL_UUID}`,
  "/api/billing/summary",
  "/api/modules",
  "/api/modules/pricing",
];

describe("API auth guard (agency/tenants/billing/modules)", () => {
  for (const path of PROTECTED_READS) {
    it(`GET ${path} returns 401 without a session`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: "Unauthorized" });
    });
  }

  it("PATCH /api/agency/settings returns 401 without a session", async () => {
    const res = await request(app)
      .patch("/api/agency/settings")
      .send({ platformName: "Attacker", markupPercent: 0 });
    expect(res.status).toBe(401);
  });

  it("POST /api/tenants returns 401 without a session", async () => {
    const res = await request(app)
      .post("/api/tenants")
      .send({ brandName: "Intruder" });
    expect(res.status).toBe(401);
  });

  it("PATCH /api/tenants/:id returns 401 without a session", async () => {
    const res = await request(app)
      .patch(`/api/tenants/${NIL_UUID}`)
      .send({ status: "suspended" });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/tenants/:id returns 401 without a session", async () => {
    const res = await request(app).delete(`/api/tenants/${NIL_UUID}`);
    expect(res.status).toBe(401);
  });

  it("POST /api/billing/checkout returns 401 without a session", async () => {
    const res = await request(app)
      .post("/api/billing/checkout")
      .send({ tenantId: NIL_UUID, moduleIds: [] });
    expect(res.status).toBe(401);
  });
});
