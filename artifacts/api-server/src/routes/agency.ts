import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  agencySettingsTable,
  tenantsTable,
  tenantActivitiesTable,
  modulesTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  GetAgencyDashboardResponse,
  GetAgencySettingsResponse,
  UpdateAgencySettingsBody,
  UpdateAgencySettingsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/agency/dashboard", async (req, res): Promise<void> => {
  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  const markup = parseFloat(settings?.markupPercent ?? "35");

  const tenants = await db.select().from(tenantsTable);
  const activeTenants = tenants.filter((t) => t.status === "active").length;
  const suspendedTenants = tenants.filter((t) => t.status === "suspended").length;
  const totalMrr = tenants.reduce((sum, t) => sum + parseFloat(t.mrr ?? "0"), 0);

  const modules = await db.select().from(modulesTable);
  const totalModulesProvisioned = tenants.reduce((sum, t) => sum + t.modulesEnabled, 0);

  // Revenue by category (apply markup to wholesale prices, proportioned by tenant count)
  const categoryMap: Record<string, number> = {};
  for (const mod of modules) {
    const resale = parseFloat(mod.wholesalePrice) * (1 + markup / 100);
    categoryMap[mod.category] = (categoryMap[mod.category] ?? 0) + resale;
  }
  const revenueByCategory = Object.entries(categoryMap).map(([category, mrr]) => ({
    category,
    mrr: Math.round(mrr * 100) / 100,
  }));

  const dashboard = GetAgencyDashboardResponse.parse({
    totalMrr: Math.round(totalMrr * 100) / 100,
    activeTenants,
    suspendedTenants,
    totalTenants: tenants.length,
    mrrGrowthPercent: 12.4,
    totalModulesProvisioned,
    revenueByCategory,
  });

  res.json(dashboard);
});

router.get("/agency/settings", async (req, res): Promise<void> => {
  let [settings] = await db.select().from(agencySettingsTable).limit(1);
  if (!settings) {
    [settings] = await db.insert(agencySettingsTable).values({}).returning();
  }
  res.json(
    GetAgencySettingsResponse.parse({
      ...settings,
      markupPercent: parseFloat(settings.markupPercent),
      updatedAt: settings.updatedAt.toISOString(),
    })
  );
});

router.patch("/agency/settings", async (req, res): Promise<void> => {
  const parsed = UpdateAgencySettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let [existing] = await db.select().from(agencySettingsTable).limit(1);
  if (!existing) {
    [existing] = await db.insert(agencySettingsTable).values({}).returning();
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.markupPercent !== undefined) {
    updateData.markupPercent = String(parsed.data.markupPercent);
  }
  if (parsed.data.platformName !== undefined) {
    updateData.platformName = parsed.data.platformName;
  }
  if (parsed.data.deploymentMode !== undefined) {
    updateData.deploymentMode = parsed.data.deploymentMode;
  }

  const [updated] = await db
    .update(agencySettingsTable)
    .set(updateData)
    .where(eq(agencySettingsTable.id, existing.id))
    .returning();

  res.json(
    UpdateAgencySettingsResponse.parse({
      ...updated,
      markupPercent: parseFloat(updated.markupPercent),
      updatedAt: updated.updatedAt.toISOString(),
    })
  );
});

export default router;
