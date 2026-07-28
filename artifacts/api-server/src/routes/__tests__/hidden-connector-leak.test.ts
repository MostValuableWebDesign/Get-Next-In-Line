import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mock @workspace/db so tests run without a real database.
// The fake module rows include ALL hidden connector fields — if a route ever
// spreads the raw row into a response, the leak assertions below will fail.
// ---------------------------------------------------------------------------
const fakeModules = [
  {
    id: 1,
    name: "Email Automation",
    slug: "email-automation",
    category: "Marketing",
    categorySlug: "marketing",
    description: "Automated email campaigns",
    isActive: true,
    wholesalePrice: "10.00",
    upstreamVendor: "SecretVendor Inc",
    hiddenConnector: "secretvendor-connector",
    proxyNotes: "Internal proxy notes — never show tenants",
    // A non-partners row with a partnerBrand set in the DB — the route must
    // null it (white-label contract; partnerBrand is partners-only).
    partnerBrand: "LeakyBrand LLC",
  },
  {
    id: 2,
    name: "SMS Blaster",
    slug: "sms-blaster",
    category: "Messaging",
    categorySlug: "messaging",
    description: "Bulk SMS sending",
    isActive: false,
    wholesalePrice: "25.50",
    upstreamVendor: "HiddenSMS Corp",
    hiddenConnector: "hiddensms-connector",
    proxyNotes: "Route via proxy tier 2",
  },
];

const fakeSettings = [{ markupPercent: "35" }];

vi.mock("@workspace/db", () => {
  const modulesTable = { categorySlug: "categorySlug", name: "name" };
  const agencySettingsTable = {};
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === modulesTable ? fakeModules : fakeSettings;
        return {
          orderBy: (..._args: unknown[]) => Promise.resolve(rows),
          limit: (_n: number) => Promise.resolve(rows),
        };
      },
    }),
  };
  return { db, pool: undefined, modulesTable, agencySettingsTable };
});

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // so session cookies work over plain HTTP in supertest

const HIDDEN_FIELDS = ["slug", "upstreamVendor", "hiddenConnector", "proxyNotes"] as const;
const HIDDEN_VALUES = [
  "SecretVendor Inc",
  "secretvendor-connector",
  "HiddenSMS Corp",
  "hiddensms-connector",
  "proxy",
];

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

describe("tenant-facing module endpoints never leak hidden connector fields", () => {
  it("GET /api/modules contains none of the hidden connector fields", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/modules");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const item of res.body) {
      for (const field of HIDDEN_FIELDS) {
        expect(item).not.toHaveProperty(field);
      }
    }
    const raw = JSON.stringify(res.body);
    for (const value of HIDDEN_VALUES) {
      expect(raw).not.toContain(value);
    }
  });

  it("GET /api/modules nulls partnerBrand for non-partners categories even when the DB row has one", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/modules");
    expect(res.status).toBe(200);
    for (const item of res.body) {
      expect(item.partnerBrand).toBeNull();
    }
    expect(JSON.stringify(res.body)).not.toContain("LeakyBrand");
  });

  it("GET /api/modules/pricing contains none of the hidden connector fields", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/modules/pricing");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const item of res.body) {
      for (const field of HIDDEN_FIELDS) {
        expect(item).not.toHaveProperty(field);
      }
    }
    const raw = JSON.stringify(res.body);
    for (const value of HIDDEN_VALUES) {
      expect(raw).not.toContain(value);
    }
  });
});

describe("admin connector registry requires an authenticated session", () => {
  it("returns 401 without a session", async () => {
    const res = await request(app).get("/api/admin/connector-registry");
    expect(res.status).toBe(401);
    const raw = JSON.stringify(res.body);
    for (const value of HIDDEN_VALUES) {
      expect(raw).not.toContain(value);
    }
  });

  it("returns 401 with an invalid session cookie", async () => {
    const res = await request(app)
      .get("/api/admin/connector-registry")
      .set("Cookie", "gnil.sid=s%3Aforged-session-id.invalidsignature");
    expect(res.status).toBe(401);
  });

  it("returns the registry (including hidden fields) once authenticated", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/admin/connector-registry");
    expect(res.status).toBe(200);
    expect(res.body[0]).toHaveProperty("upstreamVendor");
    expect(res.body[0]).toHaveProperty("hiddenConnector");
  });
});
