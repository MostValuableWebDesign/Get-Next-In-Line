import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  modulesTable,
  tenantsTable,
  partnerConnectionsTable,
  partnerConnectionEventsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

import { seedConnectorMapping, CONNECTOR_MAPPING, RETIRED_MODULES } from "../connectorSeed";
import { encryptToken } from "../partnerCrypto";

// ---------------------------------------------------------------------------
// Connector seed retirement (Guideline → Gusto consolidation), against the
// REAL dev database:
//   - the retired Guideline module is DEACTIVATED, never deleted (billing /
//     provisioning history survives);
//   - any live partner connection on the retired module is force-disconnected:
//     credentials purged + explanatory audit event, mirroring the tenant-facing
//     disconnect semantics;
//   - re-running the seed is idempotent (no duplicate audit events);
//   - Gusto absorbs the offering: consolidated name/description, and keeps its
//     Partner-Direct contract (brand "Gusto", 0% markup, $0 wholesale).
// ---------------------------------------------------------------------------

const RUN = `gseed-${Date.now()}-${process.pid}`;

let guidelineModuleId: number;
let guidelineInsertedByTest = false;
let tenantId: number;
let connectionId: number;

beforeAll(async () => {
  // Ensure a legacy Guideline row exists (as any install seeded before the
  // consolidation would have) and force it active so this run exercises the
  // deactivation path deterministically.
  const [existing] = await db
    .select()
    .from(modulesTable)
    .where(eq(modulesTable.slug, "guideline"));
  if (existing) {
    guidelineModuleId = existing.id;
    await db
      .update(modulesTable)
      .set({ isActive: true })
      .where(eq(modulesTable.id, guidelineModuleId));
  } else {
    guidelineInsertedByTest = true;
    const [inserted] = await db
      .insert(modulesTable)
      .values({
        name: "401(k) & Employee Benefits",
        slug: "guideline",
        category: "Partner-Direct Integrations",
        categorySlug: "partners",
        description: "legacy Guideline row (pre-consolidation)",
        wholesalePrice: "0.00",
        markupPercentOverride: "0",
        partnerBrand: "Guideline",
        isActive: true,
      })
      .returning({ id: modulesTable.id });
    guidelineModuleId = inserted.id;
  }

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `Seed Retire Tenant ${RUN}`, subdomain: `${RUN}-t` })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;

  // A tenant with a live Guideline connection, credentials stored encrypted.
  const [conn] = await db
    .insert(partnerConnectionsTable)
    .values({
      tenantId,
      moduleId: guidelineModuleId,
      status: "active",
      accessTokenEncrypted: encryptToken(`sandbox_access_${RUN}`),
      refreshTokenEncrypted: encryptToken(`sandbox_refresh_${RUN}`),
      webhookSecretEncrypted: encryptToken(`whsec_${RUN}`),
      connectedAt: new Date(),
      lastSyncAt: new Date(),
    })
    .returning({ id: partnerConnectionsTable.id });
  connectionId = conn.id;
});

afterAll(async () => {
  await db
    .delete(partnerConnectionEventsTable)
    .where(eq(partnerConnectionEventsTable.connectionId, connectionId));
  await db
    .delete(partnerConnectionsTable)
    .where(eq(partnerConnectionsTable.id, connectionId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (guidelineInsertedByTest) {
    await db.delete(modulesTable).where(eq(modulesTable.id, guidelineModuleId));
  }
});

async function auditEvents() {
  return db
    .select()
    .from(partnerConnectionEventsTable)
    .where(
      and(
        eq(partnerConnectionEventsTable.connectionId, connectionId),
        eq(partnerConnectionEventsTable.eventType, "disconnected")
      )
    );
}

describe("connector seed retires Guideline into Gusto", () => {
  it("mapping no longer carries Guideline; Gusto covers payroll + 401(k)/benefits with the Partner-Direct contract", () => {
    expect(CONNECTOR_MAPPING.find((e) => e.slug === "guideline")).toBeUndefined();
    expect(RETIRED_MODULES.some((r) => r.slug === "guideline")).toBe(true);

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

  it("deactivates (not deletes) Guideline, disconnects live connections with an audit event, and updates Gusto's row", async () => {
    await seedConnectorMapping();

    // Guideline row survives, deactivated.
    const [guideline] = await db
      .select()
      .from(modulesTable)
      .where(eq(modulesTable.id, guidelineModuleId));
    expect(guideline).toBeDefined();
    expect(guideline.isActive).toBe(false);

    // Gusto row carries the consolidated catalog copy + contract.
    const [gusto] = await db
      .select()
      .from(modulesTable)
      .where(eq(modulesTable.slug, "gusto"));
    expect(gusto).toBeDefined();
    expect(gusto.isActive).toBe(true);
    expect(gusto.name).toBe("Payroll, 401(k) & Employee Benefits");
    expect(gusto.description).toMatch(/401\(k\) administration/i);
    expect(gusto.partnerBrand).toBe("Gusto");
    // Pass-through contract: 0% markup is re-stamped on every seed run.
    // (wholesalePrice is only written on insert — the mapping declares $0,
    // asserted above — so legacy rows keep whatever billing already used.)
    expect(parseFloat(gusto.markupPercentOverride!)).toBe(0);

    // The tenant's connection is cleanly disconnected: credentials purged...
    const [conn] = await db
      .select()
      .from(partnerConnectionsTable)
      .where(eq(partnerConnectionsTable.id, connectionId));
    expect(conn.status).toBe("not_connected");
    expect(conn.accessTokenEncrypted).toBeNull();
    expect(conn.refreshTokenEncrypted).toBeNull();
    expect(conn.webhookSecretEncrypted).toBeNull();
    expect(conn.oauthState).toBeNull();
    expect(conn.connectedAt).toBeNull();

    // ...with an audit event explaining the consolidation into Gusto.
    const events = await auditEvents();
    expect(events.length).toBe(1);
    expect(events[0].details).toMatch(/Gusto/);
    expect(events[0].details).toMatch(/credentials purged/i);
  });

  it("re-running the seed is idempotent: still deactivated, no duplicate audit events", async () => {
    await seedConnectorMapping();

    const [guideline] = await db
      .select()
      .from(modulesTable)
      .where(eq(modulesTable.id, guidelineModuleId));
    expect(guideline.isActive).toBe(false);

    const events = await auditEvents();
    expect(events.length).toBe(1);

    // Reseeding never resurrects or duplicates retired rows.
    const guidelineRows = await db
      .select()
      .from(modulesTable)
      .where(inArray(modulesTable.slug, ["guideline"]));
    expect(guidelineRows.length).toBe(1);
  });
});
