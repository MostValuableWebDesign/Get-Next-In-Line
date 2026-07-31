import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  modulesTable,
  tenantsTable,
  tenantModulesTable,
  partnerConnectionsTable,
  partnerConnectionEventsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

import { seedConnectorMapping, CONNECTOR_MAPPING, RETIRED_MODULES } from "../connectorSeed";
import { encryptToken } from "../partnerCrypto";

// ---------------------------------------------------------------------------
// Connector seed retirement with a successor (Guideline → Gusto), against the
// REAL dev database — the MIGRATE-THEN-REMOVE flow:
//   - tenant activations of the retired module are re-pointed to the successor
//     keeping charged wholesale/resale snapshots, cadence, payment mode, and
//     the provisioning date intact (billing history survives unchanged);
//   - a tenant that already holds the successor keeps its existing activation
//     (the redundant retired one is dropped — never double-billed) and its
//     MRR / module count are pulled back in line;
//   - each affected tenant gets an explanatory audit event on its successor
//     connection history (created when absent);
//   - the retired module row is then HARD-DELETED and never re-created —
//     re-running the seed is a no-op (no duplicate audit events);
//   - Gusto carries the consolidated offering under the Partner-Direct
//     contract (brand "Gusto", 0% markup, $0 wholesale).
// ---------------------------------------------------------------------------

const RUN = `gseed-${Date.now()}-${process.pid}`;
const PROVISIONED_AT = new Date("2025-11-03T12:00:00Z");

let gustoModuleId: number;
let guidelineModuleId: number;
// Tenant A: Guideline only — activation is re-pointed to Gusto.
let tenantAId: number;
let tenantAAssignmentId: number;
// Tenant B: already has Gusto AND Guideline — deduped, keeps its Gusto row.
let tenantBId: number;
let tenantBGustoAssignmentId: number;

beforeAll(async () => {
  // Make sure the consolidated Gusto row exists before staging legacy state.
  await seedConnectorMapping();
  const [gusto] = await db.select().from(modulesTable).where(eq(modulesTable.slug, "gusto"));
  expect(gusto).toBeDefined();
  gustoModuleId = gusto.id;

  // Re-create the legacy Guideline module row exactly as a pre-consolidation
  // install would still carry it (active, with a legacy non-zero price).
  const [guideline] = await db
    .insert(modulesTable)
    .values({
      name: "401(k) & Employee Benefits",
      slug: "guideline",
      category: "Partner-Direct Integrations",
      categorySlug: "partners",
      description: "legacy Guideline row (pre-consolidation)",
      wholesalePrice: "39.00",
      markupPercentOverride: "0",
      partnerBrand: "Guideline",
      isActive: true,
    })
    .returning({ id: modulesTable.id });
  guidelineModuleId = guideline.id;

  // Tenant A: a live Guideline connection + a paid Guideline activation with
  // realized price snapshots.
  const [tenantA] = await db
    .insert(tenantsTable)
    .values({
      brandName: `Seed Migrate Tenant A ${RUN}`,
      subdomain: `${RUN}-a`,
      mrr: "39.00",
      modulesEnabled: 1,
    })
    .returning({ id: tenantsTable.id });
  tenantAId = tenantA.id;

  const [assignmentA] = await db
    .insert(tenantModulesTable)
    .values({
      tenantId: tenantAId,
      moduleId: guidelineModuleId,
      billingCadence: "monthly",
      chargedWholesale: "39.00",
      chargedResale: "39.00",
      paymentMode: "simulated",
      provisionedAt: PROVISIONED_AT,
    })
    .returning({ id: tenantModulesTable.id });
  tenantAAssignmentId = assignmentA.id;

  await db.insert(partnerConnectionsTable).values({
    tenantId: tenantAId,
    moduleId: guidelineModuleId,
    status: "active",
    accessTokenEncrypted: encryptToken(`sandbox_access_${RUN}`),
    refreshTokenEncrypted: encryptToken(`sandbox_refresh_${RUN}`),
    webhookSecretEncrypted: encryptToken(`whsec_${RUN}`),
    connectedAt: new Date(),
    lastSyncAt: new Date(),
  });

  // Tenant B: already on Gusto, plus a redundant Guideline activation.
  const [tenantB] = await db
    .insert(tenantsTable)
    .values({
      brandName: `Seed Migrate Tenant B ${RUN}`,
      subdomain: `${RUN}-b`,
      mrr: "39.00",
      modulesEnabled: 2,
    })
    .returning({ id: tenantsTable.id });
  tenantBId = tenantB.id;

  const [gustoAssignment] = await db
    .insert(tenantModulesTable)
    .values({
      tenantId: tenantBId,
      moduleId: gustoModuleId,
      billingCadence: "monthly",
      chargedWholesale: "0.00",
      chargedResale: "0.00",
      paymentMode: "simulated",
    })
    .returning({ id: tenantModulesTable.id });
  tenantBGustoAssignmentId = gustoAssignment.id;

  await db.insert(tenantModulesTable).values({
    tenantId: tenantBId,
    moduleId: guidelineModuleId,
    billingCadence: "monthly",
    chargedWholesale: "39.00",
    chargedResale: "39.00",
    paymentMode: "simulated",
  });
});

afterAll(async () => {
  // Delete the tenants — their activations, connections, and connection
  // events cascade away with them. The Guideline module row is gone (that is
  // the point of the test); clean it up anyway in case of failures.
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantAId, tenantBId]));
  await db.delete(modulesTable).where(eq(modulesTable.slug, "guideline"));
});

async function migrationEventsFor(tenantId: number) {
  const [conn] = await db
    .select()
    .from(partnerConnectionsTable)
    .where(
      and(
        eq(partnerConnectionsTable.moduleId, gustoModuleId),
        eq(partnerConnectionsTable.tenantId, tenantId)
      )
    );
  if (!conn) return { conn: undefined, events: [] as { details: string | null }[] };
  const events = await db
    .select()
    .from(partnerConnectionEventsTable)
    .where(
      and(
        eq(partnerConnectionEventsTable.connectionId, conn.id),
        eq(partnerConnectionEventsTable.eventType, "module_migrated")
      )
    );
  return { conn, events };
}

describe("connector seed migrates Guideline onto Gusto, then removes it", () => {
  it("mapping no longer carries Guideline; the retirement entry names Gusto as successor; Gusto covers payroll + 401(k)/benefits under the Partner-Direct contract", () => {
    expect(CONNECTOR_MAPPING.find((e) => e.slug === "guideline")).toBeUndefined();
    const retired = RETIRED_MODULES.find((r) => r.slug === "guideline");
    expect(retired).toBeDefined();
    expect(retired!.successorSlug).toBe("gusto");

    const gusto = CONNECTOR_MAPPING.find((e) => e.slug === "gusto")!;
    expect(gusto).toBeDefined();
    expect(gusto.name).toMatch(/401\(k\)/);
    expect(gusto.description).toMatch(/payroll/i);
    expect(gusto.description).toMatch(/401\(k\)/);
    expect(gusto.description).toMatch(/benefits/i);
    // Partner-Direct contract: brand, pass-through pricing.
    expect(gusto.partnerBrand).toBe("Gusto");
    expect(gusto.markupPercentOverride).toBe("0");
    expect(gusto.wholesalePrice).toBe("0.00");
    expect(gusto.categorySlug).toBe("partners");
  });

  it("re-points activations, dedupes tenants already on Gusto, records audit events, and hard-deletes the Guideline row", async () => {
    await seedConnectorMapping();

    // The Guideline module row is gone entirely.
    const guidelineRows = await db
      .select()
      .from(modulesTable)
      .where(eq(modulesTable.slug, "guideline"));
    expect(guidelineRows.length).toBe(0);

    // Tenant A's activation was re-pointed to Gusto in place: same row id,
    // same charged snapshots, cadence, payment mode, and provisioning date.
    const [assignmentA] = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.id, tenantAAssignmentId));
    expect(assignmentA).toBeDefined();
    expect(assignmentA.moduleId).toBe(gustoModuleId);
    expect(assignmentA.chargedWholesale).toBe("39.00");
    expect(assignmentA.chargedResale).toBe("39.00");
    expect(assignmentA.billingCadence).toBe("monthly");
    expect(assignmentA.paymentMode).toBe("simulated");
    expect(assignmentA.provisionedAt.toISOString()).toBe(PROVISIONED_AT.toISOString());

    // Tenant A's billing is unchanged: same MRR, still one module.
    const [tenantA] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantAId));
    expect(tenantA.mrr).toBe("39.00");
    expect(tenantA.modulesEnabled).toBe(1);

    // Tenant B keeps its ORIGINAL Gusto activation and nothing else — the
    // redundant Guideline row is gone and it is no longer double-billed.
    const tenantBAssignments = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.tenantId, tenantBId));
    expect(tenantBAssignments.length).toBe(1);
    expect(tenantBAssignments[0].id).toBe(tenantBGustoAssignmentId);
    expect(tenantBAssignments[0].moduleId).toBe(gustoModuleId);
    const [tenantB] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantBId));
    expect(tenantB.mrr).toBe("0.00");
    expect(tenantB.modulesEnabled).toBe(1);

    // Both tenants carry an explanatory consolidation event on their Gusto
    // connection history (tenant A's was created by the migration; its old
    // Guideline connection — and history — went away with the module row).
    for (const tenantId of [tenantAId, tenantBId]) {
      const { conn, events } = await migrationEventsFor(tenantId);
      expect(conn).toBeDefined();
      expect(events.length).toBe(1);
      expect(events[0].details).toMatch(/Gusto/);
      expect(events[0].details).toMatch(/carried over unchanged/i);
    }

    // Tenant A's migrated connection starts clean: no credentials carried.
    const { conn: connA } = await migrationEventsFor(tenantAId);
    expect(connA!.status).toBe("not_connected");
    expect(connA!.accessTokenEncrypted).toBeNull();
    expect(connA!.refreshTokenEncrypted).toBeNull();
    expect(connA!.webhookSecretEncrypted).toBeNull();
  });

  it("re-running the seed is idempotent: Guideline never reappears, no duplicate audit events, snapshots untouched", async () => {
    await seedConnectorMapping();

    const guidelineRows = await db
      .select()
      .from(modulesTable)
      .where(eq(modulesTable.slug, "guideline"));
    expect(guidelineRows.length).toBe(0);

    for (const tenantId of [tenantAId, tenantBId]) {
      const { events } = await migrationEventsFor(tenantId);
      expect(events.length).toBe(1);
    }

    const [assignmentA] = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.id, tenantAAssignmentId));
    expect(assignmentA.moduleId).toBe(gustoModuleId);
    expect(assignmentA.chargedWholesale).toBe("39.00");
    expect(assignmentA.chargedResale).toBe("39.00");
  });
});
