import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "crypto";
import {
  db,
  tenantsTable,
  usersTable,
  userTenantMembershipsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for user↔tenant access authorization: a signed-in user
// may only act on tenants they are a member of. Cross-tenant references —
// via the x-tenant-id header, a /tenants/:id URL param, a tenantId query
// param, or a tenantId/hostTenantId body field — are rejected with 403.
// Platform admins (password login) retain access to every tenant.
//
// Isolation: throwaway tenants + user per run; rows cascade on delete.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `taccess-${Date.now()}-${process.pid}`;

let adminAgent: ReturnType<typeof request.agent>;
let memberAgent: ReturnType<typeof request.agent>;
let tenantA: number; // member's tenant
let tenantB: number; // foreign tenant
let userId: number;

const asTenant = (id: number) => ({ "x-tenant-id": String(id) });

beforeAll(async () => {
  const app = (await import("../../app")).default;

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Access A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `Access B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  tenantA = tenants[0].id;
  tenantB = tenants[1].id;

  // Seed a non-admin user who is a member of tenant A only.
  const loginToken = `tok-${RUN}-${randomBytes(12).toString("hex")}`;
  const [user] = await db
    .insert(usersTable)
    // "merchant" — the governance role for a business member managing their
    // own tenant (the schema default "staff" is read-only on these surfaces).
    .values({ username: `member-${RUN}`, isPlatformAdmin: false, role: "merchant", loginToken })
    .returning({ id: usersTable.id });
  userId = user.id;
  await db
    .insert(userTenantMembershipsTable)
    .values({ userId, tenantId: tenantA });

  adminAgent = request.agent(app);
  await adminAgent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  memberAgent = request.agent(app);
  await memberAgent.post("/api/auth/login").send({ loginToken }).expect(200);
});

afterAll(async () => {
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantA, tenantB]));
});

describe("header-based tenant scoping (SOS + co-op)", () => {
  it("member can read their own tenant's appointments and messages", async () => {
    await memberAgent.get("/api/sos/appointments").set(asTenant(tenantA)).expect(200);
    await memberAgent.get("/api/sos/messages").set(asTenant(tenantA)).expect(200);
  });

  it("member cannot read another tenant's appointments, messages, or co-op surfaces", async () => {
    for (const path of [
      "/api/sos/appointments",
      "/api/sos/messages",
      "/api/sos/customers",
      "/api/coop/directory",
      "/api/coop/perks",
    ]) {
      const res = await memberAgent.get(path).set(asTenant(tenantB));
      expect(res.status, path).toBe(403);
    }
  });

  it("member cannot mutate another tenant's data via header scope", async () => {
    const res = await memberAgent
      .post("/api/sos/resources")
      .set(asTenant(tenantB))
      .send({ name: `Chair ${RUN}`, resourceType: "chair" });
    expect(res.status).toBe(403);
  });
});

describe("URL-param-based tenant scoping (/tenants/:id)", () => {
  it("member can read and update their own tenant's settings", async () => {
    await memberAgent.get(`/api/tenants/${tenantA}/settings`).expect(200);
    await memberAgent
      .patch(`/api/tenants/${tenantA}/settings`)
      .send({ businessName: `Access A ${RUN}` })
      .expect(200);
  });

  it("member cannot read or mutate another tenant's settings or concierge data", async () => {
    const denied = await memberAgent.get(`/api/tenants/${tenantB}/settings`);
    expect(denied.status).toBe(403);
    const deniedPatch = await memberAgent
      .patch(`/api/tenants/${tenantB}/settings`)
      .send({ businessName: "hijacked" });
    expect(deniedPatch.status).toBe(403);
    const deniedProfiles = await memberAgent.get(`/api/tenants/${tenantB}/client-profiles`);
    expect(deniedProfiles.status).toBe(403);
    const deniedLogs = await memberAgent.get(`/api/tenants/${tenantB}/message-logs`);
    expect(deniedLogs.status).toBe(403);
  });
});

describe("body- and query-based tenant scoping", () => {
  it("member cannot dispatch concierge messages as another tenant (body tenantId)", async () => {
    const res = await memberAgent
      .post("/api/concierge/dispatch-message")
      .send({ tenantId: tenantB, clientProfileId: 1, body: "hi" });
    expect(res.status).toBe(403);
  });

  it("member can target their own tenant via body tenantId (passes authorization)", async () => {
    // 404 (no such client profile) proves it got past the 403 gate.
    const res = await memberAgent
      .post("/api/concierge/dispatch-message")
      .send({ tenantId: tenantA, clientProfileId: 999999999, body: "hi" });
    expect(res.status).toBe(404);
  });

  it("member cannot list another tenant's partnerships via query tenantId", async () => {
    const res = await memberAgent.get(`/api/coop/partnerships?tenantId=${tenantB}`);
    expect(res.status).toBe(403);
    await memberAgent.get(`/api/coop/partnerships?tenantId=${tenantA}`).expect(200);
  });
});

describe("platform-admin-only surfaces", () => {
  it("member is blocked from the agency console, tenant provisioning, and the global activity feed", async () => {
    expect((await memberAgent.get("/api/agency/settings")).status).toBe(403);
    // GET /tenants is allowed for members but scoped to their memberships
    // (governance roles feature) — creation stays admin-only.
    const list = await memberAgent.get("/api/tenants").expect(200);
    const listedIds = (list.body as Array<{ id: number }>).map((t) => t.id);
    expect(listedIds).toContain(tenantA);
    expect(listedIds).not.toContain(tenantB);
    expect(
      (
        await memberAgent
          .post("/api/tenants")
          .send({ brandName: "x", subdomain: `${RUN}-x` })
      ).status,
    ).toBe(403);
    expect((await memberAgent.get("/api/tenants/activity")).status).toBe(403);
    // ...but the per-tenant activity feed for their own tenant works.
    await memberAgent.get(`/api/tenants/activity?tenantId=${tenantA}`).expect(200);
    expect((await memberAgent.get(`/api/tenants/activity?tenantId=${tenantB}`)).status).toBe(403);
  });

  it("member is blocked from cross-tenant aggregates (billing, module rosters, unscoped partnerships)", async () => {
    expect((await memberAgent.get("/api/billing/summary")).status).toBe(403);
    expect((await memberAgent.get("/api/modules/tenant-counts")).status).toBe(403);
    expect((await memberAgent.get("/api/modules/1/tenants")).status).toBe(403);
    expect((await memberAgent.get("/api/coop/partnerships")).status).toBe(403);
    expect(
      (await memberAgent.patch("/api/coop/partnerships/1").send({ isActive: false })).status,
    ).toBe(403);
  });

  it("admin retains access to every tenant and the consoles", async () => {
    await adminAgent.get("/api/billing/summary").expect(200);
    await adminAgent.get("/api/coop/partnerships").expect(200);
    await adminAgent.get("/api/tenants").expect(200);
    await adminAgent.get("/api/sos/appointments").set(asTenant(tenantA)).expect(200);
    await adminAgent.get("/api/sos/appointments").set(asTenant(tenantB)).expect(200);
    await adminAgent.get(`/api/tenants/${tenantB}/settings`).expect(200);
  });
});

describe("legacy scope and session behavior", () => {
  it("member requests need explicit tenant context; the legacy scope is opt-in", async () => {
    // SOS routes now reject requests without tenant context outright…
    await memberAgent.get("/api/sos/dashboard").expect(400);
    // …and the legacy NULL-tenant scope stays reachable via explicit opt-in.
    await memberAgent.get("/api/sos/dashboard").set("x-tenant-id", "legacy").expect(200);
  });

  it("unauthenticated requests remain 401, not 403", async () => {
    const anon = request.agent((await import("../../app")).default);
    const res = await anon.get("/api/sos/appointments").set(asTenant(tenantA));
    expect(res.status).toBe(401);
  });

  it("a bogus login token is rejected", async () => {
    const anon = request.agent((await import("../../app")).default);
    await anon.post("/api/auth/login").send({ loginToken: "nope" }).expect(401);
  });
});
