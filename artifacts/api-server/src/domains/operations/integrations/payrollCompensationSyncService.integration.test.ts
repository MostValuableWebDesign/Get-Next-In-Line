import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  tenantIntegrationCapabilitiesTable,
  tenantsTable,
  workforceCapabilitySyncsTable,
  workforceCompensationsTable,
  workforceIntegrationConnectionsTable,
  workforcePayrollRunsTable,
  workforcePeopleTable,
} from "@workspace/db";
import { encryptToken } from "../../../lib/partnerCrypto";
import { gustoProvider } from "./gustoProvider";
import { listCompensation, syncCompensation, syncPayroll } from "./payrollCompensationSyncService";

process.env.GUSTO_CLIENT_ID = "payroll-test-client";
process.env.GUSTO_CLIENT_SECRET = "payroll-test-secret";
process.env.GUSTO_REDIRECT_URI = "http://localhost/callback";
process.env.GUSTO_API_BASE_URL = "https://gusto.payroll.test";

const RUN = `payroll-${Date.now()}-${process.pid}`;
let tenantA: number;
let tenantB: number;

function jsonResponse(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function payroll(externalId: string, gross = "100.00", processed = true) {
  return {
    payroll_uuid: externalId,
    pay_period: { start_date: "2026-01-01", end_date: "2026-01-14" },
    check_date: "2026-01-16",
    processed,
    processed_date: processed ? "2026-01-15" : null,
    calculated_at: "2026-01-15T12:00:00Z",
    totals: { gross_pay: gross, net_pay: "80.00" },
  };
}

function employeeWithJobs(...jobIds: string[]) {
  return {
    uuid: "employee-1",
    first_name: "Ada",
    last_name: "Lovelace",
    jobs: jobIds.map((uuid) => ({ uuid, title: "Stylist", hire_date: "2024-01-02" })),
  };
}

function compensation(jobId: string, rate: string) {
  return {
    uuid: `comp-${jobId}`,
    job_uuid: jobId,
    rate,
    payment_unit: "Hour",
    effective_date: "2026-01-01",
  };
}

async function resetTenant(tenantId: number) {
  await db.delete(workforceCompensationsTable).where(eq(workforceCompensationsTable.tenantId, tenantId));
  await db.delete(workforcePayrollRunsTable).where(eq(workforcePayrollRunsTable.tenantId, tenantId));
  await db.delete(workforceCapabilitySyncsTable).where(eq(workforceCapabilitySyncsTable.tenantId, tenantId));
  await db.delete(workforcePeopleTable).where(eq(workforcePeopleTable.tenantId, tenantId));
  await db.delete(tenantIntegrationCapabilitiesTable).where(eq(tenantIntegrationCapabilitiesTable.tenantId, tenantId));
  await db.delete(workforceIntegrationConnectionsTable).where(eq(workforceIntegrationConnectionsTable.tenantId, tenantId));
}

async function connect(tenantId: number, scopes: string[], capabilities: string[]) {
  await db.insert(workforceIntegrationConnectionsTable).values({
    tenantId,
    providerId: "gusto",
    status: "connected",
    accessTokenEncrypted: encryptToken("access-token"),
    refreshTokenEncrypted: encryptToken("refresh-token"),
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    providerAccountId: `company-${tenantId}`,
    scopes,
  });
  if (capabilities.length) {
    await db.insert(tenantIntegrationCapabilitiesTable).values(
      capabilities.map((capability) => ({
        tenantId,
        capability,
        providerId: "gusto",
        isPrimary: true,
      })),
    );
  }
}

beforeAll(async () => {
  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Payroll A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `Payroll B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  tenantA = tenants[0].id;
  tenantB = tenants[1].id;
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetTenant(tenantA);
  await resetTenant(tenantB);
});

afterAll(async () => {
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantA, tenantB]));
});

describe("Gusto payroll and compensation synchronization", () => {
  it("paginates payroll at 100 records with exact verified query parameters and enforces scope", async () => {
    await connect(tenantA, ["payrolls:read"], ["payroll"]);
    const firstPage = Array.from({ length: 100 }, (_, index) => payroll(`pay-${index}`));
    const urls: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      urls.push(url);
      return jsonResponse(url.includes("page=1") ? firstPage : [payroll("pay-100")]);
    });

    const result = await gustoProvider.listPayrollRuns!({ tenantId: tenantA });
    expect(result).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const urlText of urls) {
      const url = new URL(urlText);
      expect(url.searchParams.get("processing_statuses")).toBe("processed,unprocessed");
      expect(url.searchParams.get("payroll_types")).toBe("regular,off_cycle,external");
      expect(url.searchParams.get("include")).toBe("totals");
      expect(url.searchParams.get("per")).toBe("100");
    }
    expect(new URL(urls[0]).searchParams.get("page")).toBe("1");
    expect(new URL(urls[1]).searchParams.get("page")).toBe("2");

    await db
      .update(workforceIntegrationConnectionsTable)
      .set({ scopes: [] })
      .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA));
    await expect(gustoProvider.listPayrollRuns!({ tenantId: tenantA })).rejects.toThrow(
      "payrolls:read scope",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("repeats payroll sync idempotently, updates normalized fields, and never deletes omissions", async () => {
    await connect(tenantA, ["payrolls:read"], ["payroll"]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementationOnce(() => jsonResponse([payroll("pay-a", "100.00"), payroll("pay-b", "200.00")]));
    await syncPayroll({ tenantId: tenantA, providerId: "gusto" });
    fetchMock.mockImplementationOnce(() =>
      jsonResponse([
        {
          ...payroll("pay-a", "300.00", false),
          check_date: null,
          processed_date: null,
          calculated_at: null,
          totals: { gross_pay: "300.00", net_pay: null },
        },
      ]),
    );
    await syncPayroll({ tenantId: tenantA, providerId: "gusto" });

    const rows = await db
      .select()
      .from(workforcePayrollRunsTable)
      .where(eq(workforcePayrollRunsTable.tenantId, tenantA));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.externalId === "pay-a")).toMatchObject({
      grossPayCents: "30000",
      netPayCents: "8000",
      paymentDate: "2026-01-16",
      processedDate: "2026-01-15",
      calculatedAt: new Date("2026-01-15T12:00:00Z"),
      status: "draft",
      processed: false,
    });
    expect(rows.find((row) => row.externalId === "pay-b")).toBeDefined();
  });

  it("preserves payroll rows after a failed fetch and records capability failure/degraded state", async () => {
    await connect(tenantA, ["payrolls:read"], ["payroll"]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementationOnce(() => jsonResponse([payroll("pay-a")]));
    await syncPayroll({ tenantId: tenantA, providerId: "gusto" });
    fetchMock.mockImplementation(() => jsonResponse({ secretProviderBody: "never exposed" }, 429));
    await expect(syncPayroll({ tenantId: tenantA, providerId: "gusto" })).rejects.toThrow("status 429");

    expect(await db.select().from(workforcePayrollRunsTable).where(eq(workforcePayrollRunsTable.tenantId, tenantA))).toHaveLength(1);
    const [metadata] = await db
      .select()
      .from(workforceCapabilitySyncsTable)
      .where(and(eq(workforceCapabilitySyncsTable.tenantId, tenantA), eq(workforceCapabilitySyncsTable.capability, "payroll")));
    expect(metadata).toMatchObject({ status: "failed" });
    const [connection] = await db
      .select()
      .from(workforceIntegrationConnectionsTable)
      .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA));
    expect(connection.status).toBe("degraded");
    expect(connection.lastError).not.toContain("secretProviderBody");
  });

  it("links compensation to the same-tenant workforce person, updates repeats, and retains omitted jobs", async () => {
    await connect(tenantA, ["employees:read", "compensations:read"], ["compensation"]);
    await db.insert(workforcePeopleTable).values({
      tenantId: tenantA,
      providerId: "gusto",
      externalId: "employee-1",
      personType: "employee",
      displayName: "Ada Lovelace",
      employmentStatus: "active",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockImplementationOnce(() => jsonResponse([employeeWithJobs("job-a", "job-b")]))
      .mockImplementationOnce(() => jsonResponse([compensation("job-a", "25.00")]))
      .mockImplementationOnce(() => jsonResponse([compensation("job-b", "40.00")]));
    await syncCompensation({ tenantId: tenantA, providerId: "gusto" });
    fetchMock
      .mockImplementationOnce(() => jsonResponse([employeeWithJobs("job-a")]))
      .mockImplementationOnce(() => jsonResponse([compensation("job-a", "30.00")]));
    await syncCompensation({ tenantId: tenantA, providerId: "gusto" });

    const rows = await db.select().from(workforceCompensationsTable).where(eq(workforceCompensationsTable.tenantId, tenantA));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.externalJobId === "job-a")).toMatchObject({
      amountCents: "3000",
      workforcePersonId: expect.any(Number),
    });
    expect(rows.find((row) => row.externalJobId === "job-b")).toBeDefined();
    expect(rows[0].workforcePersonId).toBe(rows[1].workforcePersonId);
    const listed = await listCompensation(tenantA);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workforcePersonId: rows[0].workforcePersonId,
          displayName: "Ada Lovelace",
        }),
      ]),
    );
  });

  it("does not partially write compensation when a provider job fails", async () => {
    await connect(tenantA, ["employees:read", "compensations:read"], ["compensation"]);
    await db.insert(workforcePeopleTable).values({
      tenantId: tenantA,
      providerId: "gusto",
      externalId: "employee-1",
      personType: "employee",
      displayName: "Ada Lovelace",
      employmentStatus: "active",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockImplementationOnce(() => jsonResponse([employeeWithJobs("job-a", "job-b")]))
      .mockImplementationOnce(() => jsonResponse([compensation("job-a", "25.00")]))
      .mockImplementationOnce(() => jsonResponse([compensation("job-b", "40.00")]));
    await syncCompensation({ tenantId: tenantA, providerId: "gusto" });
    const before = await db.select().from(workforceCompensationsTable).where(eq(workforceCompensationsTable.tenantId, tenantA));

    fetchMock
      .mockImplementationOnce(() => jsonResponse([employeeWithJobs("job-a", "job-b")]))
      .mockImplementationOnce(() => jsonResponse([compensation("job-a", "99.00")]))
      .mockImplementationOnce(() => jsonResponse({ raw: "provider body" }, 500));
    await expect(syncCompensation({ tenantId: tenantA, providerId: "gusto" })).rejects.toThrow();
    const after = await db.select().from(workforceCompensationsTable).where(eq(workforceCompensationsTable.tenantId, tenantA));
    expect(after.map((row) => [row.externalJobId, row.amountCents])).toEqual(
      before.map((row) => [row.externalJobId, row.amountCents]),
    );
  });

  it("requires primary capability ownership and isolates list persistence by tenant", async () => {
    await connect(tenantA, ["payrolls:read", "employees:read", "compensations:read"], []);
    await expect(syncPayroll({ tenantId: tenantA, providerId: "gusto" })).rejects.toMatchObject({ status: 409 });
    await expect(syncCompensation({ tenantId: tenantA, providerId: "gusto" })).rejects.toMatchObject({ status: 409 });
    await connect(tenantB, ["payrolls:read"], ["payroll"]);
    await db.insert(workforcePayrollRunsTable).values({
      tenantId: tenantB,
      providerId: "gusto",
      externalId: "tenant-b-payroll",
      status: "processed",
      payPeriodStart: "2026-01-01",
      payPeriodEnd: "2026-01-14",
      processed: true,
      grossPayCents: "99999999999999999999",
      netPayCents: "1",
      currency: "USD",
    });
    const tenantARows = await db.select().from(workforcePayrollRunsTable).where(eq(workforcePayrollRunsTable.tenantId, tenantA));
    expect(tenantARows).toHaveLength(0);
    expect((await db.select().from(workforcePayrollRunsTable).where(eq(workforcePayrollRunsTable.tenantId, tenantB)))).toHaveLength(1);
  });

  it("keeps reauthorization_required after a refresh/auth failure", async () => {
    await connect(tenantA, ["payrolls:read"], ["payroll"]);
    await db
      .update(workforceIntegrationConnectionsTable)
      .set({ tokenExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => jsonResponse({ error: "invalid_grant" }, 401));
    await expect(syncPayroll({ tenantId: tenantA, providerId: "gusto" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [connection] = await db
      .select()
      .from(workforceIntegrationConnectionsTable)
      .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA));
    expect(connection.status).toBe("reauthorization_required");
  });

  it("does not clear another capability's degraded state or last error on success", async () => {
    await connect(tenantA, ["payrolls:read"], ["payroll"]);
    await db
      .update(workforceIntegrationConnectionsTable)
      .set({ status: "degraded", lastError: "compensation capability failed" })
      .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA));
    await db.insert(workforceCapabilitySyncsTable).values({
      tenantId: tenantA,
      providerId: "gusto",
      capability: "compensation",
      status: "failed",
      lastError: "compensation capability failed",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(() => jsonResponse([]));
    await syncPayroll({ tenantId: tenantA, providerId: "gusto" });
    const [connection] = await db
      .select()
      .from(workforceIntegrationConnectionsTable)
      .where(eq(workforceIntegrationConnectionsTable.tenantId, tenantA));
    expect(connection).toMatchObject({
      status: "degraded",
      lastError: "compensation capability failed",
    });
  });
});