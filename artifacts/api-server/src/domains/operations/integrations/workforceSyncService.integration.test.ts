import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  sosStaffMembersTable,
  tenantIntegrationCapabilitiesTable,
  tenantsTable,
  workforceIntegrationConnectionsTable,
  workforcePeopleTable,
  workforceStaffLinksTable,
} from "@workspace/db";
import { encryptToken } from "../../../lib/partnerCrypto";
import {
  listWorkforcePeople,
  setWorkforceStaffLink,
  syncWorkforceEmployees,
} from "./workforceSyncService";

const RUN = `${Date.now()}-${process.pid}`;
let tenantA: number;
let tenantB: number;

function response(people: unknown[], status = 200) {
  return Promise.resolve(new Response(JSON.stringify(people), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function employee(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "emp-1",
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ADA@example.com",
    phone: "5551001000",
    terminated: false,
    jobs: [{ title: "Senior Stylist", hire_date: "2024-01-02" }],
    ...overrides,
  };
}

beforeAll(async () => {
  process.env.GUSTO_CLIENT_ID = "test-client";
  process.env.GUSTO_CLIENT_SECRET = "test-secret";
  process.env.GUSTO_REDIRECT_URI = "https://example.test/callback";
  process.env.GUSTO_API_BASE_URL = "https://gusto.test";
  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: "Workforce A", subdomain: `workforce-a-${RUN}` },
      { brandName: "Workforce B", subdomain: `workforce-b-${RUN}` },
    ])
    .returning({ id: tenantsTable.id });
  [tenantA, tenantB] = tenants.map((tenant) => tenant.id);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.delete(workforcePeopleTable).where(inArray(workforcePeopleTable.tenantId, [tenantA, tenantB]));
  await db.delete(tenantIntegrationCapabilitiesTable).where(inArray(tenantIntegrationCapabilitiesTable.tenantId, [tenantA, tenantB]));
  await db.delete(workforceIntegrationConnectionsTable).where(inArray(workforceIntegrationConnectionsTable.tenantId, [tenantA, tenantB]));
  await db.delete(sosStaffMembersTable).where(inArray(sosStaffMembersTable.tenantId, [tenantA, tenantB]));
  await db.insert(tenantIntegrationCapabilitiesTable).values({
    tenantId: tenantA,
    capability: "employees",
    providerId: "gusto",
    isPrimary: true,
  });
  await db.insert(workforceIntegrationConnectionsTable).values({
    tenantId: tenantA,
    providerId: "gusto",
    status: "connected",
    accessTokenEncrypted: encryptToken("access"),
    refreshTokenEncrypted: encryptToken("refresh"),
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    providerAccountId: "company-a",
    scopes: ["employees:read"],
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantA, tenantB]));
});

describe("workforce synchronization", () => {
  it("inserts, updates, remains idempotent, and never deletes absent employees", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementationOnce(() => response([employee()]));
    await expect(syncWorkforceEmployees({ tenantId: tenantA, providerId: "gusto" }))
      .resolves.toMatchObject({ created: 1, updated: 0, unchanged: 0 });

    fetchMock.mockImplementationOnce(() => response([employee()]));
    await expect(syncWorkforceEmployees({ tenantId: tenantA, providerId: "gusto" }))
      .resolves.toMatchObject({ created: 0, updated: 0, unchanged: 1 });

    fetchMock.mockImplementationOnce(() => response([employee({
      terminated: true,
      terminations: [{ effective_date: "2026-09-01" }],
      jobs: [{ title: "Lead Stylist", hire_date: "2024-01-02" }],
    })]));
    await expect(syncWorkforceEmployees({ tenantId: tenantA, providerId: "gusto" }))
      .resolves.toMatchObject({ updated: 1 });
    const [updated] = await db.select().from(workforcePeopleTable).where(eq(workforcePeopleTable.tenantId, tenantA));
    expect(updated).toMatchObject({
      employmentStatus: "terminated",
      jobTitle: "Lead Stylist",
      terminationDate: "2026-09-01",
    });

    fetchMock.mockImplementationOnce(() => response([]));
    await syncWorkforceEmployees({ tenantId: tenantA, providerId: "gusto" });
    expect(await db.select().from(workforcePeopleTable).where(eq(workforcePeopleTable.tenantId, tenantA))).toHaveLength(1);
  });

  it("auto-links only one exact tenant email match and leaves ambiguous matches unlinked", async () => {
    const [single] = await db.insert(sosStaffMembersTable).values({
      tenantId: tenantA,
      name: "Ada",
      email: "ada@example.com",
      compensationType: "commission",
      commissionPercent: 50,
    }).returning({ id: sosStaffMembersTable.id });
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => response([employee()]));
    await syncWorkforceEmployees({ tenantId: tenantA, providerId: "gusto" });
    let [person] = await listWorkforcePeople(tenantA);
    expect(person).toMatchObject({ gnilStaffId: single.id, linkType: "auto_email" });

    await db.delete(workforcePeopleTable).where(eq(workforcePeopleTable.tenantId, tenantA));
    await db.insert(sosStaffMembersTable).values({
      tenantId: tenantA,
      name: "Another Ada",
      email: "ADA@example.com",
      compensationType: "commission",
      commissionPercent: 50,
    });
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => response([employee()]));
    await syncWorkforceEmployees({ tenantId: tenantA, providerId: "gusto" });
    [person] = await listWorkforcePeople(tenantA);
    expect(person.gnilStaffId).toBeNull();
  });

  it("supports explicit tenant-safe manual mapping", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => response([employee()]));
    await syncWorkforceEmployees({ tenantId: tenantA, providerId: "gusto" });
    const [person] = await db.select().from(workforcePeopleTable).where(eq(workforcePeopleTable.tenantId, tenantA));
    const [staff] = await db.insert(sosStaffMembersTable).values({
      tenantId: tenantA,
      name: "Ada Manual",
      compensationType: "commission",
      commissionPercent: 50,
    }).returning({ id: sosStaffMembersTable.id });
    await setWorkforceStaffLink({ tenantId: tenantA, personId: person.id, staffId: staff.id });
    const [link] = await db.select().from(workforceStaffLinksTable).where(eq(workforceStaffLinksTable.workforcePersonId, person.id));
    expect(link).toMatchObject({ tenantId: tenantA, gnilStaffId: staff.id, linkType: "manual" });
    await expect(setWorkforceStaffLink({ tenantId: tenantB, personId: person.id, staffId: staff.id })).rejects.toMatchObject({ status: 404 });
  });

  it("rejects disconnected or non-owning providers", async () => {
    await db.update(workforceIntegrationConnectionsTable).set({ status: "not_connected" }).where(and(eq(workforceIntegrationConnectionsTable.tenantId, tenantA), eq(workforceIntegrationConnectionsTable.providerId, "gusto")));
    await expect(syncWorkforceEmployees({ tenantId: tenantA, providerId: "gusto" })).rejects.toMatchObject({ status: 409 });
    await db.delete(tenantIntegrationCapabilitiesTable).where(eq(tenantIntegrationCapabilitiesTable.tenantId, tenantA));
    await expect(syncWorkforceEmployees({ tenantId: tenantA, providerId: "gusto" })).rejects.toMatchObject({ status: 409 });
  });

  it("records failures without corrupting the previous good record", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementationOnce(() => response([employee()]));
    await syncWorkforceEmployees({ tenantId: tenantA, providerId: "gusto" });
    fetchMock.mockImplementation(() => response({ error: "down" } as unknown as unknown[], 500));
    await expect(syncWorkforceEmployees({ tenantId: tenantA, providerId: "gusto" })).rejects.toThrow();
    const [person] = await db.select().from(workforcePeopleTable).where(eq(workforcePeopleTable.tenantId, tenantA));
    expect(person.displayName).toBe("Ada Lovelace");
    const [connection] = await db.select().from(workforceIntegrationConnectionsTable).where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA));
    expect(connection.status).toBe("degraded");
    expect(connection.lastError).toContain("status 500");
  });

  it("rejects duplicate provider IDs before writing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => response([employee(), employee()]));
    await expect(syncWorkforceEmployees({ tenantId: tenantA, providerId: "gusto" })).rejects.toThrow("duplicate workforce IDs");
    expect(await db.select().from(workforcePeopleTable).where(eq(workforcePeopleTable.tenantId, tenantA))).toHaveLength(0);
  });
});