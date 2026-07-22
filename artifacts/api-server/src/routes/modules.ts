import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { modulesTable, agencySettingsTable, tenantModulesTable, tenantsTable } from "@workspace/db";
import {
  ListModulesResponse,
  GetModulesPricingResponse,
  GetModuleTenantCountsResponse,
  GetModuleTenantsResponse,
} from "@workspace/api-zod";
import { eq, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/modules", async (_req, res): Promise<void> => {
  const modules = await db.select().from(modulesTable).orderBy(modulesTable.categorySlug, modulesTable.name);

  res.json(
    ListModulesResponse.parse(
      // Explicitly pick tenant-safe fields — hidden connector fields
      // (slug, upstreamVendor, hiddenConnector, proxyNotes) must never leak here.
      modules.map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        categorySlug: m.categorySlug,
        description: m.description,
        isActive: m.isActive,
        wholesalePrice: parseFloat(m.wholesalePrice),
      }))
    )
  );
});

router.get("/modules/tenant-counts", async (_req, res): Promise<void> => {
  const modules = await db.select({ id: modulesTable.id }).from(modulesTable);

  const counts = await db
    .select({
      moduleId: tenantModulesTable.moduleId,
      activeTenantCount: sql<number>`count(*)::int`,
    })
    .from(tenantModulesTable)
    .innerJoin(tenantsTable, eq(tenantModulesTable.tenantId, tenantsTable.id))
    .where(eq(tenantsTable.status, "active"))
    .groupBy(tenantModulesTable.moduleId);

  const countMap = new Map(counts.map((c) => [c.moduleId, c.activeTenantCount]));

  res.json(
    GetModuleTenantCountsResponse.parse(
      modules.map((m) => ({
        moduleId: m.id,
        activeTenantCount: countMap.get(m.id) ?? 0,
      }))
    )
  );
});

router.get("/modules/:id/tenants", async (req, res): Promise<void> => {
  const moduleId = Number(req.params.id);
  if (!Number.isInteger(moduleId)) {
    res.status(404).json({ error: "Module not found" });
    return;
  }

  const [module] = await db.select({ id: modulesTable.id }).from(modulesTable).where(eq(modulesTable.id, moduleId));
  if (!module) {
    res.status(404).json({ error: "Module not found" });
    return;
  }

  const rows = await db
    .select({
      tenantId: tenantsTable.id,
      brandName: tenantsTable.brandName,
      subdomain: tenantsTable.subdomain,
      status: tenantsTable.status,
      provisionedAt: tenantModulesTable.provisionedAt,
    })
    .from(tenantModulesTable)
    .innerJoin(tenantsTable, eq(tenantModulesTable.tenantId, tenantsTable.id))
    .where(eq(tenantModulesTable.moduleId, moduleId))
    .orderBy(tenantsTable.brandName);

  res.json(
    GetModuleTenantsResponse.parse(
      rows.map((r) => ({
        tenantId: r.tenantId,
        brandName: r.brandName,
        subdomain: r.subdomain,
        status: r.status,
        provisionedAt: r.provisionedAt.toISOString(),
      }))
    )
  );
});

router.get("/modules/pricing", async (_req, res): Promise<void> => {
  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  const markup = parseFloat(settings?.markupPercent ?? "35");

  const modules = await db.select().from(modulesTable).orderBy(modulesTable.categorySlug, modulesTable.name);

  res.json(
    GetModulesPricingResponse.parse(
      modules.map((m) => {
        const wholesale = parseFloat(m.wholesalePrice);
        const resale = Math.round(wholesale * (1 + markup / 100) * 100) / 100;
        return {
          id: m.id,
          name: m.name,
          category: m.category,
          wholesalePrice: wholesale,
          resalePrice: resale,
          markupPercent: markup,
          margin: Math.round((resale - wholesale) * 100) / 100,
        };
      })
    )
  );
});

export default router;
