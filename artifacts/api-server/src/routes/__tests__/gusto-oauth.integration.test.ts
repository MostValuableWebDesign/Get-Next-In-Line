import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  tenantIntegrationCapabilitiesTable,
  tenantsTable,
  usersTable,
  userTenantMembershipsTable,
  workforceIntegrationConnectionsTable,
  workforceOAuthStatesTable,
} from "@workspace/db";
import { decryptToken, encryptToken } from "../../lib/partnerCrypto";
import { getFreshGustoAccessToken } from "../../domains/operations/integrations/gusto/gustoOAuthService";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
process.env.GUSTO_CLIENT_ID = "gusto-client-test";
process.env.GUSTO_CLIENT_SECRET = "gusto-secret-test";
process.env.GUSTO_REDIRECT_URI =
  "http://localhost/api/operations/integrations/gusto/callback";
process.env.GUSTO_ENVIRONMENT = "demo";
delete process.env.REPLIT_DEV_DOMAIN;

const RUN = `gusto-oauth-${Date.now()}-${process.pid}`;
let app: import("express").Express;
let agent: ReturnType<typeof request.agent>;
let tenantA: number;
let tenantB: number;
let tenantC: number;
let staffUserId: number;
let staffAgent: ReturnType<typeof request.agent>;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function begin(tenantId = tenantA): Promise<string> {
  const response = await agent
    .post("/api/operations/integrations/gusto/connect")
    .set("x-tenant-id", String(tenantId))
    .expect(200);
  const url = new URL(response.body.authorizationUrl);
  expect(url.origin).toBe("https://api.gusto-demo.com");
  expect(url.pathname).toBe("/oauth/authorize");
  expect(url.searchParams.get("client_id")).toBe("gusto-client-test");
  return url.searchParams.get("state")!;
}

beforeAll(async () => {
  app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD }).expect(200);
  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Gusto A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `Gusto B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
      { brandName: `Gusto C ${RUN}`, subdomain: `${RUN}-c`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  tenantA = tenants[0].id;
  tenantB = tenants[1].id;
  tenantC = tenants[2].id;
  const [staff] = await db
    .insert(usersTable)
    .values({
      username: `gusto-staff-${RUN}`,
      loginToken: `gusto-staff-token-${RUN}`,
      role: "staff",
      isPlatformAdmin: false,
    })
    .returning({ id: usersTable.id });
  staffUserId = staff.id;
  await db
    .insert(userTenantMembershipsTable)
    .values({ userId: staffUserId, tenantId: tenantA });
  staffAgent = request.agent(app);
  await staffAgent
    .post("/api/auth/login")
    .send({ loginToken: `gusto-staff-token-${RUN}` })
    .expect(200);
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await db.delete(usersTable).where(eq(usersTable.id, staffUserId));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantA, tenantB, tenantC]));
});

describe("Gusto OAuth lifecycle", () => {
  it("makes first-time employee, payroll, and compensation sync usable after OAuth", async () => {
    const state = await begin(tenantC);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "complete-access-token",
          refresh_token: "complete-refresh-token",
          expires_in: 7200,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          scope: "employees:read payrolls:read compensations:read",
          resource: { type: "Company", uuid: `complete-company-${RUN}` },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            uuid: `employee-${RUN}`,
            first_name: "Ada",
            last_name: "Lovelace",
            work_email: `${RUN}@example.com`,
            jobs: [{ uuid: `job-${RUN}`, title: "Engineer", primary: true }],
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            uuid: `employee-${RUN}`,
            first_name: "Ada",
            last_name: "Lovelace",
            work_email: `${RUN}@example.com`,
            jobs: [{ uuid: `job-${RUN}`, title: "Engineer", primary: true }],
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            uuid: `compensation-${RUN}`,
            job_uuid: `job-${RUN}`,
            rate: "42.50",
            payment_unit: "Hour",
            effective_date: "2026-01-01",
          },
        ]),
      );

    await agent
      .get("/api/operations/integrations/gusto/callback")
      .query({ state, code: "complete-authorization-code" })
      .expect(302);

    const capabilities = await db
      .select({
        capability: tenantIntegrationCapabilitiesTable.capability,
        providerId: tenantIntegrationCapabilitiesTable.providerId,
      })
      .from(tenantIntegrationCapabilitiesTable)
      .where(eq(tenantIntegrationCapabilitiesTable.tenantId, tenantC));
    expect(capabilities).toEqual(
      expect.arrayContaining([
        { capability: "employees", providerId: "gusto" },
        { capability: "payroll", providerId: "gusto" },
        { capability: "compensation", providerId: "gusto" },
      ]),
    );

    const tenant = { "x-tenant-id": String(tenantC) };
    const staffSync = await agent
      .post("/api/operations/integrations/gusto/sync")
      .set(tenant)
      .expect(200);
    const payrollSync = await agent
      .post("/api/operations/integrations/gusto/sync/payroll")
      .set(tenant)
      .expect(200);
    const compensationSync = await agent
      .post("/api/operations/integrations/gusto/sync/compensation")
      .set(tenant)
      .expect(200);

    expect(staffSync.body).not.toMatchObject({ status: 409 });
    expect(payrollSync.body.status).toBe("succeeded");
    expect(compensationSync.body.status).toBe("succeeded");
  });

  it("rejects mismatched state", async () => {
    await begin();
    await agent
      .get("/api/operations/integrations/gusto/callback")
      .query({ state: "wrong-state", code: "code" })
      .expect(400);
  });

  it("blocks staff from changing integration credentials", async () => {
    await staffAgent
      .post("/api/operations/integrations/gusto/connect")
      .set("x-tenant-id", String(tenantA))
      .expect(403);
    await staffAgent
      .post("/api/operations/integrations/gusto/disconnect")
      .set("x-tenant-id", String(tenantA))
      .expect(403);
    await staffAgent
      .post("/api/operations/integrations/gusto/sync")
      .set("x-tenant-id", String(tenantA))
      .expect(403);
  });

  it("removes Gusto from the legacy sandbox partner workflow", async () => {
    const listed = await agent.get("/api/v1/partners").expect(200);
    expect(listed.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ partnerId: "gusto" })]),
    );
    await agent
      .post("/api/v1/partners/gusto/connect")
      .set("x-tenant-id", String(tenantA))
      .expect(404);
  });

  it("rejects expired state", async () => {
    const state = await begin();
    await db
      .update(workforceOAuthStatesTable)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workforceOAuthStatesTable.tenantId, tenantA));
    await agent
      .get("/api/operations/integrations/gusto/callback")
      .query({ state, code: "code" })
      .expect(400);
  });

  it("connects only after token exchange and prevents state replay", async () => {
    const state = await begin();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "real-access-token",
          refresh_token: "real-refresh-token",
          expires_in: 7200,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          scope: "employees:read companies:read",
          resource: { type: "Company", uuid: `company-${RUN}` },
        }),
      );

    await agent
      .get("/api/operations/integrations/gusto/callback")
      .query({ state, code: "authorization-code" })
      .expect(302);

    const [connection] = await db
      .select()
      .from(workforceIntegrationConnectionsTable)
      .where(
        and(
          eq(workforceIntegrationConnectionsTable.tenantId, tenantA),
          eq(workforceIntegrationConnectionsTable.providerId, "gusto"),
        ),
      );
    expect(connection.status).toBe("connected");
    expect(connection.providerAccountId).toBe(`company-${RUN}`);
    expect(connection.scopes).toEqual(["employees:read", "companies:read"]);
    expect(connection.accessTokenEncrypted).not.toContain("real-access-token");
    expect(connection.refreshTokenEncrypted).not.toContain("real-refresh-token");
    expect(decryptToken(connection.accessTokenEncrypted!)).toBe("real-access-token");
    expect(decryptToken(connection.refreshTokenEncrypted!)).toBe("real-refresh-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await agent
      .get("/api/operations/integrations/gusto/callback")
      .query({ state, code: "authorization-code" })
      .expect(400);
  });

  it("does not stage a reconnect over a usable connection and preserves it on failure", async () => {
    const before = (
      await db
        .select()
        .from(workforceIntegrationConnectionsTable)
        .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA))
    )[0];
    const state = await begin(tenantA);
    const during = (
      await db
        .select()
        .from(workforceIntegrationConnectionsTable)
        .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA))
    )[0];
    expect(during.status).toBe("connected");
    expect(during.providerAccountId).toBe(before.providerAccountId);
    expect(during.accessTokenEncrypted).toBe(before.accessTokenEncrypted);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "invalid_grant" }, 401),
    );
    await agent
      .get("/api/operations/integrations/gusto/callback")
      .query({ state, code: "bad-reconnect-code" })
      .expect(302);

    const after = (
      await db
        .select()
        .from(workforceIntegrationConnectionsTable)
        .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA))
    )[0];
    expect(after.status).toBe("connected");
    expect(after.providerAccountId).toBe(before.providerAccountId);
    expect(after.accessTokenEncrypted).toBe(before.accessTokenEncrypted);
    expect(after.refreshTokenEncrypted).toBe(before.refreshTokenEncrypted);
  });

  it("keeps reauthorization_required until a replacement callback succeeds", async () => {
    await db
      .update(workforceIntegrationConnectionsTable)
      .set({ status: "reauthorization_required", lastError: "refresh failed" })
      .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA));
    const state = await begin(tenantA);
    const during = (
      await db
        .select({ status: workforceIntegrationConnectionsTable.status })
        .from(workforceIntegrationConnectionsTable)
        .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA))
    )[0];
    expect(during.status).toBe("reauthorization_required");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "replacement-access",
          refresh_token: "replacement-refresh",
          expires_in: 7200,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          scope: "employees:read payrolls:read",
          resource: { type: "Company", uuid: `replacement-company-${RUN}` },
        }),
      );
    await agent
      .get("/api/operations/integrations/gusto/callback")
      .query({ state, code: "replacement-code" })
      .expect(302);
    const [after] = await db
      .select()
      .from(workforceIntegrationConnectionsTable)
      .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA));
    expect(after.status).toBe("connected");
    expect(after.providerAccountId).toBe(`replacement-company-${RUN}`);
    expect(decryptToken(after.accessTokenEncrypted!)).toBe("replacement-access");
  });

  it("records a failed token exchange without marking Gusto connected", async () => {
    const state = await begin(tenantB);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "invalid_grant" }, 401),
    );
    await agent
      .get("/api/operations/integrations/gusto/callback")
      .query({ state, code: "bad-code" })
      .expect(302);
    const status = await agent
      .get("/api/operations/integrations/gusto/status")
      .set("x-tenant-id", String(tenantB))
      .expect(200);
    expect(status.body.state).toBe("error");
    expect(status.body.providerAccountId).toBeNull();
  });

  it("rotates an expiring access and single-use refresh token", async () => {
    await db
      .update(workforceIntegrationConnectionsTable)
      .set({
        status: "connected",
        accessTokenEncrypted: encryptToken("expired-access"),
        refreshTokenEncrypted: encryptToken("single-use-refresh"),
        tokenExpiresAt: new Date(Date.now() - 1_000),
      })
      .where(
        and(
          eq(workforceIntegrationConnectionsTable.tenantId, tenantA),
          eq(workforceIntegrationConnectionsTable.providerId, "gusto"),
        ),
      );
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 7200,
      }),
    );

    await expect(getFreshGustoAccessToken(tenantA)).resolves.toBe("rotated-access");
    const [connection] = await db
      .select()
      .from(workforceIntegrationConnectionsTable)
      .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA));
    expect(decryptToken(connection.refreshTokenEncrypted!)).toBe("rotated-refresh");
  });

  it("serializes concurrent refreshes so the single-use token is exchanged once", async () => {
    await db
      .update(workforceIntegrationConnectionsTable)
      .set({
        status: "connected",
        accessTokenEncrypted: encryptToken("expired-concurrent-access"),
        refreshTokenEncrypted: encryptToken("single-use-concurrent-refresh"),
        tokenExpiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        access_token: "concurrent-rotated-access",
        refresh_token: "concurrent-rotated-refresh",
        expires_in: 7200,
      }),
    );

    await expect(
      Promise.all([
        getFreshGustoAccessToken(tenantA),
        getFreshGustoAccessToken(tenantA),
      ]),
    ).resolves.toEqual(["concurrent-rotated-access", "concurrent-rotated-access"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("disconnects only the selected tenant and removes its credentials", async () => {
    await agent
      .post("/api/operations/integrations/gusto/disconnect")
      .set("x-tenant-id", String(tenantA))
      .expect(200);
    const [a, b] = await Promise.all([
      agent
        .get("/api/operations/integrations/gusto/status")
        .set("x-tenant-id", String(tenantA)),
      agent
        .get("/api/operations/integrations/gusto/status")
        .set("x-tenant-id", String(tenantB)),
    ]);
    expect(a.body.state).toBe("not_connected");
    expect(b.body.state).toBe("error");
    const [connection] = await db
      .select()
      .from(workforceIntegrationConnectionsTable)
      .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA));
    expect(connection.accessTokenEncrypted).toBeNull();
    expect(connection.refreshTokenEncrypted).toBeNull();
  });
});