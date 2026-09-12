import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  tenantIntegrationCapabilitiesTable,
  tenantsTable,
  workforceIntegrationConnectionsTable,
} from "@workspace/db";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;

const RUN = `workforce-${Date.now()}-${process.pid}`;

let app: import("express").Express;
let agent: ReturnType<typeof request.agent>;
let tenantA: number;
let tenantB: number;

beforeAll(async () => {
  app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD }).expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Workforce A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `Workforce B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  tenantA = tenants[0].id;
  tenantB = tenants[1].id;

  await db.insert(workforceIntegrationConnectionsTable).values([
    {
      tenantId: tenantA,
      providerId: "gusto",
      status: "connected",
      providerAccountId: `company-${RUN}-a`,
      scopes: ["employees:read"],
      connectedAt: new Date(),
      lastSuccessfulSyncAt: new Date(),
    },
    {
      tenantId: tenantB,
      providerId: "gusto",
      status: "connected",
      providerAccountId: `company-${RUN}-b`,
      scopes: ["employees:read", "payrolls:read"],
      connectedAt: new Date(),
    },
  ]);
});

afterAll(async () => {
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantA, tenantB]));
});

describe("Operations workforce persistence", () => {
  it("keeps capability ownership isolated by tenant", async () => {
    await db.insert(tenantIntegrationCapabilitiesTable).values([
      { tenantId: tenantA, capability: "employees", providerId: "gusto", isPrimary: true },
      { tenantId: tenantB, capability: "payroll", providerId: "gusto", isPrimary: true },
    ]);

    const tenantAResponse = await agent
      .get("/api/operations/overview")
      .set("x-tenant-id", String(tenantA))
      .expect(200);
    const tenantBResponse = await agent
      .get("/api/operations/overview")
      .set("x-tenant-id", String(tenantB))
      .expect(200);

    const assignment = (
      body: typeof tenantAResponse.body,
      capability: string,
    ): { providerId: string | null; state: string } =>
      body.capabilityAssignments.find(
        (candidate: { capability: string }) => candidate.capability === capability,
      );

    expect(assignment(tenantAResponse.body, "employees")).toMatchObject({
      providerId: "gusto",
      state: "connected",
    });
    expect(assignment(tenantAResponse.body, "payroll")).toMatchObject({
      providerId: null,
      state: "unavailable",
    });
    expect(assignment(tenantBResponse.body, "employees")).toMatchObject({
      providerId: null,
      state: "unavailable",
    });
    expect(assignment(tenantBResponse.body, "payroll")).toMatchObject({
      providerId: "gusto",
      state: "connected",
    });
  });

  it("enforces only one primary owner for a tenant capability", async () => {
    await db
      .insert(tenantIntegrationCapabilitiesTable)
      .values({
        tenantId: tenantA,
        capability: "contractors",
        providerId: "gusto",
        isPrimary: true,
      });

    await expect(
      db.insert(tenantIntegrationCapabilitiesTable).values({
        tenantId: tenantA,
        capability: "contractors",
        providerId: "future-provider",
        isPrimary: true,
      }),
    ).rejects.toBeDefined();

    const rows = await db
      .select()
      .from(tenantIntegrationCapabilitiesTable)
      .where(eq(tenantIntegrationCapabilitiesTable.tenantId, tenantA));
    expect(
      rows.filter((row) => row.capability === "contractors" && row.isPrimary),
    ).toHaveLength(1);
  });

  it("does not treat legacy partner OAuth state as a workforce connection", async () => {
    const response = await agent.get("/api/operations/overview").expect(200);
    expect(response.body.connectedProviderCount).toBe(0);
    expect(response.body.providers).toEqual([
      expect.objectContaining({ providerId: "gusto", status: "not_connected" }),
    ]);
  });
});