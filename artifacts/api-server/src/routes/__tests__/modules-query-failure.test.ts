import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Regression guard for the "empty modules list caused by DB drift" incident:
// when the modules query fails (e.g. missing column), the routes must return
// a 5xx error instead of failing open with an empty list that the UI renders
// as "No modules found in this category".
// ---------------------------------------------------------------------------
vi.mock("@workspace/db", () => {
  const modulesTable = { categorySlug: "categorySlug", name: "name" };
  const agencySettingsTable = {};
  const tenantModulesTable = { moduleId: "moduleId", tenantId: "tenantId" };
  const tenantsTable = { id: "id", status: "status" };
  const db = {
    select: () => ({
      from: (_table: unknown) => {
        const failure = Promise.reject(
          new Error('column "partner_brand" does not exist'),
        );
        // Prevent unhandled-rejection noise when a chain method is used instead.
        failure.catch(() => {});
        const chain: Record<string, unknown> = {
          orderBy: () => Promise.reject(new Error('column "partner_brand" does not exist')),
          limit: () => Promise.reject(new Error('column "partner_brand" does not exist')),
          innerJoin: () => chain,
          where: () => chain,
          groupBy: () => Promise.reject(new Error('column "partner_brand" does not exist')),
          then: (onFulfilled: never, onRejected: (e: unknown) => unknown) =>
            failure.then(onFulfilled, onRejected),
        };
        return chain;
      },
    }),
  };
  return { db, pool: undefined, modulesTable, agencySettingsTable, tenantModulesTable, tenantsTable };
});

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // so session cookies work over plain HTTP in supertest

let app: import("express").Express;

beforeAll(async () => {
  app = (await import("../../app")).default;
});

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describe("modules routes fail loudly (5xx) when the DB query fails", () => {
  for (const path of ["/api/modules", "/api/modules/pricing", "/api/modules/tenant-counts"]) {
    it(`GET ${path} returns 500 instead of an empty list`, async () => {
      const agent = await loggedInAgent();
      const res = await agent.get(path);
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty("error");
      expect(Array.isArray(res.body)).toBe(false);
    });
  }
});
