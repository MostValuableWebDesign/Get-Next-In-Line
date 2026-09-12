import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  tenantIntegrationCapabilitiesTable,
  tenantsTable,
} from "@workspace/db";
import { reconcileProviderCapabilityAssignments } from "./capabilityAssignmentService";

const RUN = `capability-assignment-${Date.now()}-${process.pid}`;
let tenantId: number;

beforeAll(async () => {
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `Capability ${RUN}`, subdomain: RUN, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;
});

beforeEach(async () => {
  await db
    .delete(tenantIntegrationCapabilitiesTable)
    .where(eq(tenantIntegrationCapabilitiesTable.tenantId, tenantId));
});

afterAll(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

async function assignments() {
  return db
    .select({
      capability: tenantIntegrationCapabilitiesTable.capability,
      providerId: tenantIntegrationCapabilitiesTable.providerId,
      isPrimary: tenantIntegrationCapabilitiesTable.isPrimary,
    })
    .from(tenantIntegrationCapabilitiesTable)
    .where(eq(tenantIntegrationCapabilitiesTable.tenantId, tenantId));
}

describe("provider capability assignment reconciliation", () => {
  it("assigns only implemented capabilities whose required scopes were granted", async () => {
    const result = await reconcileProviderCapabilityAssignments({
      tenantId,
      providerId: "gusto",
      grantedScopes: ["employees:read"],
    });

    expect(result.assigned).toEqual(["employees"]);
    expect(result.unavailable).toEqual(["payroll", "compensation"]);
    expect(await assignments()).toEqual([
      { capability: "employees", providerId: "gusto", isPrimary: true },
    ]);
  });

  it("preserves another primary owner and remains idempotent on reconnect", async () => {
    await db.insert(tenantIntegrationCapabilitiesTable).values([
      {
        tenantId,
        capability: "payroll",
        providerId: "some_other_provider",
        isPrimary: true,
      },
      {
        tenantId,
        capability: "scheduling",
        providerId: "some_other_provider",
        isPrimary: true,
      },
    ]);

    const input = {
      tenantId,
      providerId: "gusto",
      grantedScopes: ["employees:read", "payrolls:read", "compensations:read"],
    };
    const first = await reconcileProviderCapabilityAssignments(input);
    const second = await reconcileProviderCapabilityAssignments(input);

    expect(first.conflicts).toEqual([
      { capability: "payroll", providerId: "some_other_provider" },
    ]);
    expect(second.alreadyOwned).toEqual(["employees", "compensation"]);
    expect(second.conflicts).toEqual(first.conflicts);
    expect(await assignments()).toEqual(
      expect.arrayContaining([
        { capability: "employees", providerId: "gusto", isPrimary: true },
        { capability: "compensation", providerId: "gusto", isPrimary: true },
        { capability: "payroll", providerId: "some_other_provider", isPrimary: true },
        { capability: "scheduling", providerId: "some_other_provider", isPrimary: true },
      ]),
    );
    expect((await assignments()).filter((row) => row.capability === "payroll")).toHaveLength(1);
    expect(await assignments()).toHaveLength(4);
  });

  it("does not delete existing assignments after a scope downgrade", async () => {
    await reconcileProviderCapabilityAssignments({
      tenantId,
      providerId: "gusto",
      grantedScopes: ["employees:read", "payrolls:read", "compensations:read"],
    });
    await reconcileProviderCapabilityAssignments({
      tenantId,
      providerId: "gusto",
      grantedScopes: ["employees:read"],
    });

    expect(await assignments()).toHaveLength(3);
  });
});