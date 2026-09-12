import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  tenantIntegrationCapabilitiesTable,
  tenantsTable,
  userTenantMembershipsTable,
  usersTable,
  workforceCompensationsTable,
  workforceCapabilitySyncsTable,
  workforceIntegrationConnectionsTable,
  workforcePayrollRunsTable,
  workforcePeopleTable,
  workforceStaffLinksTable,
} from "@workspace/db";
import { encryptToken } from "../../lib/partnerCrypto";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "operations-test-admin";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "operations-test-session";
process.env.GUSTO_CLIENT_ID = "operations-gusto-client";
process.env.GUSTO_CLIENT_SECRET = "operations-gusto-secret";
process.env.GUSTO_REDIRECT_URI = "http://localhost/callback";
process.env.GUSTO_API_BASE_URL = "https://gusto.operations.test";
delete process.env.REPLIT_DEV_DOMAIN;

const RUN = `operations-payroll-${Date.now()}-${process.pid}`;
let app: import("express").Express;
let tenantId: number;
let staffUserId: number;
let admin: ReturnType<typeof request.agent>;
let staff: ReturnType<typeof request.agent>;

beforeAll(async () => {
  app = (await import("../../app")).default;
  admin = request.agent(app);
  await admin.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD }).expect(200);
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `Operations Payroll ${RUN}`, subdomain: RUN, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `${RUN}-staff`,
      loginToken: `${RUN}-staff-token`,
      role: "staff",
      isPlatformAdmin: false,
    })
    .returning({ id: usersTable.id });
  staffUserId = user.id;
  await db.insert(userTenantMembershipsTable).values({ userId: staffUserId, tenantId });
  staff = request.agent(app);
  await staff.post("/api/auth/login").send({ loginToken: `${RUN}-staff-token` }).expect(200);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.delete(workforceCompensationsTable).where(eq(workforceCompensationsTable.tenantId, tenantId));
  await db.delete(workforceCapabilitySyncsTable).where(eq(workforceCapabilitySyncsTable.tenantId, tenantId));
  await db.delete(workforcePayrollRunsTable).where(eq(workforcePayrollRunsTable.tenantId, tenantId));
  await db.delete(workforceStaffLinksTable).where(eq(workforceStaffLinksTable.tenantId, tenantId));
  await db.delete(workforcePeopleTable).where(eq(workforcePeopleTable.tenantId, tenantId));
  await db.delete(tenantIntegrationCapabilitiesTable).where(eq(tenantIntegrationCapabilitiesTable.tenantId, tenantId));
  await db.delete(workforceIntegrationConnectionsTable).where(eq(workforceIntegrationConnectionsTable.tenantId, tenantId));
});

afterAll(async () => {
  await db.delete(usersTable).where(eq(usersTable.id, staffUserId));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantId]));
});

describe("privileged payroll and compensation operations routes", () => {
  it("denies staff both read lists and sync mutations", async () => {
    const tenant = { "x-tenant-id": String(tenantId) };
    await staff.get("/api/operations/payroll").set(tenant).expect(403);
    await staff.get("/api/operations/compensation").set(tenant).expect(403);
    await staff.post("/api/operations/integrations/gusto/sync/payroll").set(tenant).expect(403);
    await staff.post("/api/operations/integrations/gusto/sync/compensation").set(tenant).expect(403);
  });

  it("allows a privileged session and keeps overview workforce/unlinked counts tenant-scoped", async () => {
    await db.insert(workforceIntegrationConnectionsTable).values({
      tenantId,
      providerId: "gusto",
      status: "connected",
      providerAccountId: `company-${tenantId}`,
      accessTokenEncrypted: encryptToken("access"),
      refreshTokenEncrypted: encryptToken("refresh"),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scopes: ["payrolls:read", "employees:read", "compensations:read"],
    });
    await db.insert(tenantIntegrationCapabilitiesTable).values([
      { tenantId, capability: "payroll", providerId: "gusto", isPrimary: true },
      { tenantId, capability: "compensation", providerId: "gusto", isPrimary: true },
    ]);
    const [person] = await db
      .insert(workforcePeopleTable)
      .values([
        {
          tenantId,
          providerId: "gusto",
          externalId: "person-a",
          personType: "employee",
          displayName: "Linked Person",
          employmentStatus: "active",
        },
        {
          tenantId,
          providerId: "gusto",
          externalId: "person-b",
          personType: "employee",
          displayName: "Unlinked Person",
          employmentStatus: "active",
        },
      ])
      .returning({ id: workforcePeopleTable.id });
    await db.insert(workforceStaffLinksTable).values({
      tenantId,
      workforcePersonId: person.id,
      linkType: "manual",
    });
    await db.insert(workforceCompensationsTable).values({
      tenantId,
      providerId: "gusto",
      externalEmployeeId: "person-a",
      externalJobId: "job-a",
      workforcePersonId: person.id,
      amountCents: "2500",
      currency: "USD",
      interval: "hourly",
      effectiveFrom: "2026-01-01",
    });

    expect((await admin.get("/api/operations/payroll").set("x-tenant-id", String(tenantId)).expect(200)).body).toEqual([]);
    expect((await admin.get("/api/operations/compensation").set("x-tenant-id", String(tenantId)).expect(200)).body).toEqual([
      expect.objectContaining({
        workforcePersonId: person.id,
        displayName: "Linked Person",
      }),
    ]);
    const overview = await admin.get("/api/operations/overview").set("x-tenant-id", String(tenantId)).expect(200);
    expect(overview.body).toMatchObject({ workforceCount: 2, unlinkedWorkforceCount: 1 });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/payrolls")) return Promise.resolve(new Response("[]", { status: 200 }));
      if (url.includes("/employees")) return Promise.resolve(new Response("[]", { status: 200 }));
      throw new Error(`unexpected provider URL ${url}`);
    });
    await admin.post("/api/operations/integrations/gusto/sync/payroll").set("x-tenant-id", String(tenantId)).expect(200);
    await admin.post("/api/operations/integrations/gusto/sync/compensation").set("x-tenant-id", String(tenantId)).expect(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a generic API error when Gusto rate-limits a sync", async () => {
    await db.insert(workforceIntegrationConnectionsTable).values({
      tenantId,
      providerId: "gusto",
      status: "connected",
      providerAccountId: `company-${tenantId}`,
      accessTokenEncrypted: encryptToken("access"),
      refreshTokenEncrypted: encryptToken("refresh"),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scopes: ["payrolls:read"],
    });
    await db.insert(tenantIntegrationCapabilitiesTable).values({
      tenantId,
      capability: "payroll",
      providerId: "gusto",
      isPrimary: true,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ token: "must-not-reach-client" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const response = await admin
      .post("/api/operations/integrations/gusto/sync/payroll")
      .set("x-tenant-id", String(tenantId))
      .expect(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(response.body)).not.toContain("must-not-reach-client");
  });

  it("reports missing scopes and failed capability metadata without claiming connected", async () => {
    await db.insert(workforceIntegrationConnectionsTable).values({
      tenantId,
      providerId: "gusto",
      status: "connected",
      providerAccountId: `company-${tenantId}`,
      scopes: ["employees:read", "payrolls:read"],
    });
    await db.insert(tenantIntegrationCapabilitiesTable).values([
      { tenantId, capability: "employees", providerId: "gusto", isPrimary: true },
      { tenantId, capability: "payroll", providerId: "gusto", isPrimary: true },
      { tenantId, capability: "compensation", providerId: "gusto", isPrimary: true },
    ]);
    await db.insert(workforceCapabilitySyncsTable).values({
      tenantId,
      providerId: "gusto",
      capability: "payroll",
      status: "failed",
      lastError: "payroll sync failed",
    });
    const response = await admin
      .get("/api/operations/overview")
      .set("x-tenant-id", String(tenantId))
      .expect(200);
    expect(response.body.capabilityAssignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "employees",
          state: "connected",
          missingScopes: [],
        }),
        expect.objectContaining({
          capability: "payroll",
          state: "failed",
          syncStatus: "failed",
          providerStatus: "connected",
        }),
        expect.objectContaining({
          capability: "compensation",
          state: "missing_scope",
          missingScopes: ["compensations:read"],
        }),
      ]),
    );
  });
});