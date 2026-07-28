import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, coopApplicationsTable } from "@workspace/db";
import { eq, like } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Input-validation hardening (edge rejection of malformed payloads):
//   - POST /api/auth/login rejects malformed bodies with 400 (schema-parsed,
//     no raw casts).
//   - Tenant creation and co-op applications reject invalid emails.
//   - Oversized string fields are rejected, never truncated or stored raw.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // session cookies over plain HTTP in supertest

const RUN = `inpval-${Date.now()}-${process.pid}`;

let app: import("express").Express;

beforeAll(async () => {
  app = (await import("../../app")).default;
  const { __resetCoopApplicationRateLimit } = await import("../coopApplications");
  __resetCoopApplicationRateLimit();
});

afterAll(async () => {
  await db.delete(tenantsTable).where(like(tenantsTable.subdomain, `${RUN}%`));
  await db
    .delete(coopApplicationsTable)
    .where(like(coopApplicationsTable.subdomain, `${RUN}%`));
});

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describe("POST /api/auth/login body validation", () => {
  it("rejects an empty body with 400", async () => {
    const res = await request(app).post("/api/auth/login").send({});
    expect(res.status).toBe(400);
  });

  it("rejects a non-string password with 400", async () => {
    const res = await request(app).post("/api/auth/login").send({ password: 12345 });
    expect(res.status).toBe(400);
  });

  it("rejects a non-string loginToken with 400", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ loginToken: { $ne: null } });
    expect(res.status).toBe(400);
  });

  it("rejects an empty-string loginToken with 400 (was previously a silent fallthrough)", async () => {
    const res = await request(app).post("/api/auth/login").send({ loginToken: "" });
    expect(res.status).toBe(400);
  });

  it("rejects an oversized password with 400 before comparing", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ password: "x".repeat(600) });
    expect(res.status).toBe(400);
  });

  it("still returns 401 for a wrong (but well-formed) password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ password: "definitely-not-the-password" });
    expect(res.status).toBe(401);
  });

  it("still accepts a valid password login", async () => {
    await loggedInAgent();
  });
});

describe("POST /api/tenants input validation", () => {
  it("rejects an invalid contactEmail with 400", async () => {
    const agent = await loggedInAgent();
    const res = await agent.post("/api/tenants").send({
      brandName: `Bad Email ${RUN}`,
      subdomain: `${RUN}-bademail`,
      contactEmail: "not-an-email",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an oversized brandName with 400 (not truncated/stored)", async () => {
    const agent = await loggedInAgent();
    const res = await agent.post("/api/tenants").send({
      brandName: "B".repeat(500),
      subdomain: `${RUN}-bigbrand`,
    });
    expect(res.status).toBe(400);
    const [row] = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.subdomain, `${RUN}-bigbrand`));
    expect(row).toBeUndefined();
  });

  it("still accepts a valid tenant with a well-formed email", async () => {
    const agent = await loggedInAgent();
    const res = await agent.post("/api/tenants").send({
      brandName: `Good Tenant ${RUN}`,
      subdomain: `${RUN}-good`,
      contactEmail: "owner@example.com",
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /api/public/coop/applications input validation", () => {
  it("rejects an invalid contactEmail with 400", async () => {
    const res = await request(app).post("/api/public/coop/applications").send({
      businessName: `Coop Bad Email ${RUN}`,
      subdomain: `${RUN}-coopbademail`,
      contactEmail: "nope@nope",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an oversized pitch with 400 (not truncated/stored)", async () => {
    const res = await request(app).post("/api/public/coop/applications").send({
      businessName: `Coop Big Pitch ${RUN}`,
      subdomain: `${RUN}-coopbigpitch`,
      pitch: "p".repeat(5000),
    });
    expect(res.status).toBe(400);
    const [row] = await db
      .select({ id: coopApplicationsTable.id })
      .from(coopApplicationsTable)
      .where(eq(coopApplicationsTable.subdomain, `${RUN}-coopbigpitch`));
    expect(row).toBeUndefined();
  });

  it("still accepts a valid application", async () => {
    const res = await request(app).post("/api/public/coop/applications").send({
      businessName: `Coop Good ${RUN}`,
      subdomain: `${RUN}-coopgood`,
      contactEmail: "applicant@example.com",
    });
    expect(res.status).toBe(201);
  });
});
