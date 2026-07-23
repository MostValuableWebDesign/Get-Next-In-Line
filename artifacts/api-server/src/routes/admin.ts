import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  modulesTable,
  agencySettingsTable,
  tenantsTable,
  tenantModulesTable,
  tenantActivitiesTable,
} from "@workspace/db";
import {
  GetConnectorRegistryResponse,
  UpdateConnectorRegistryEntryBody,
  UpdateConnectorRegistryEntryResponse,
  GetAdminModuleDetailResponse,
} from "@workspace/api-zod";

import { effectiveMarkupPercent } from "../lib/pricing";

const router: IRouter = Router();

/**
 * Admin-only: full white-label proxy map — every module together with its
 * hidden upstream connector. This data must NEVER be served through
 * tenant-facing endpoints.
 */
router.get("/admin/connector-registry", async (_req, res): Promise<void> => {
  const modules = await db
    .select()
    .from(modulesTable)
    .orderBy(modulesTable.categorySlug, modulesTable.name);

  res.json(
    GetConnectorRegistryResponse.parse(
      modules.map((m) => ({
        id: m.id,
        name: m.name,
        slug: m.slug,
        category: m.category,
        categorySlug: m.categorySlug,
        isActive: m.isActive,
        upstreamVendor: m.upstreamVendor,
        hiddenConnector: m.hiddenConnector,
        proxyNotes: m.proxyNotes,
      }))
    )
  );
});

/**
 * Admin-only: update a module's hidden connector details (slug, upstream
 * vendor, hidden connector description, proxy notes). Never affects
 * tenant-facing endpoints.
 */
router.patch("/admin/connector-registry/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const parsed = UpdateConnectorRegistryEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }

  const updates: Partial<typeof modulesTable.$inferInsert> = {};
  if ("slug" in parsed.data) updates.slug = parsed.data.slug ?? null;
  if ("upstreamVendor" in parsed.data) updates.upstreamVendor = parsed.data.upstreamVendor ?? null;
  if ("hiddenConnector" in parsed.data) updates.hiddenConnector = parsed.data.hiddenConnector ?? null;
  if ("proxyNotes" in parsed.data) updates.proxyNotes = parsed.data.proxyNotes ?? null;

  const existing = await db.select().from(modulesTable).where(eq(modulesTable.id, id));
  if (existing.length === 0) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const [m] =
    Object.keys(updates).length === 0
      ? existing
      : await db.update(modulesTable).set(updates).where(eq(modulesTable.id, id)).returning();

  res.json(
    UpdateConnectorRegistryEntryResponse.parse({
      id: m.id,
      name: m.name,
      slug: m.slug,
      category: m.category,
      categorySlug: m.categorySlug,
      isActive: m.isActive,
      upstreamVendor: m.upstreamVendor,
      hiddenConnector: m.hiddenConnector,
      proxyNotes: m.proxyNotes,
    })
  );
});

/**
 * Admin-only: connector-aware module detail — combines the module's hidden
 * connector mapping with its tenant assignments (provisioned dates, cadence,
 * MRR contribution) and recent provisioning activity for those tenants.
 * This data must NEVER be served through tenant-facing endpoints.
 */
router.get("/admin/modules/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const [m] = await db.select().from(modulesTable).where(eq(modulesTable.id, id));
  if (!m) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  const markup = effectiveMarkupPercent(m, parseFloat(settings?.markupPercent ?? "25"));
  const wholesale = parseFloat(m.wholesalePrice);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const resale = round2(wholesale * (1 + markup / 100));
  const resaleBiweekly =
    m.wholesalePriceBiweekly != null
      ? round2(parseFloat(m.wholesalePriceBiweekly) * (1 + markup / 100))
      : undefined;

  const assignments = await db
    .select({
      tenantId: tenantsTable.id,
      brandName: tenantsTable.brandName,
      subdomain: tenantsTable.subdomain,
      status: tenantsTable.status,
      provisionedAt: tenantModulesTable.provisionedAt,
      billingCadence: tenantModulesTable.billingCadence,
    })
    .from(tenantModulesTable)
    .innerJoin(tenantsTable, eq(tenantModulesTable.tenantId, tenantsTable.id))
    .where(eq(tenantModulesTable.moduleId, id))
    .orderBy(tenantsTable.brandName);

  // Provisioning history from the existing tenant activity log, filtered to
  // entries that mention this module by name.
  const recentActivities = await db
    .select({
      id: tenantActivitiesTable.id,
      tenantId: tenantActivitiesTable.tenantId,
      tenantName: tenantsTable.brandName,
      action: tenantActivitiesTable.action,
      details: tenantActivitiesTable.details,
      timestamp: tenantActivitiesTable.timestamp,
    })
    .from(tenantActivitiesTable)
    .innerJoin(tenantsTable, eq(tenantActivitiesTable.tenantId, tenantsTable.id))
    .orderBy(desc(tenantActivitiesTable.timestamp), desc(tenantActivitiesTable.id))
    .limit(500);
  const provisioningActivity = recentActivities
    .filter((a) => a.details?.includes(m.name) ?? false)
    .slice(0, 20);

  res.json(
    GetAdminModuleDetailResponse.parse({
      mapping: {
        id: m.id,
        name: m.name,
        slug: m.slug,
        category: m.category,
        categorySlug: m.categorySlug,
        isActive: m.isActive,
        upstreamVendor: m.upstreamVendor,
        hiddenConnector: m.hiddenConnector,
        proxyNotes: m.proxyNotes,
      },
      description: m.description,
      wholesalePrice: wholesale,
      resalePrice: resale,
      markupPercent: markup,
      ...(resaleBiweekly != null ? { resalePriceBiweekly: resaleBiweekly } : {}),
      tenants: assignments.map((a) => ({
        tenantId: a.tenantId,
        brandName: a.brandName,
        subdomain: a.subdomain,
        status: a.status,
        provisionedAt: a.provisionedAt.toISOString(),
        // Cadence is per-assignment: each tenant stores its own billing
        // cadence on tenant_modules.
        cadence: a.billingCadence === "biweekly" ? "biweekly" : "monthly",
        mrrContribution:
          a.billingCadence === "biweekly" && resaleBiweekly != null
            ? round2((resaleBiweekly * 26) / 12)
            : resale,
      })),
      activity: provisioningActivity.map((a) => ({
        id: a.id,
        tenantId: a.tenantId,
        tenantName: a.tenantName,
        action: a.action,
        details: a.details,
        timestamp: a.timestamp.toISOString(),
      })),
    })
  );
});

export default router;
